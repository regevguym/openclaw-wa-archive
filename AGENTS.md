# AGENTS.md — openclaw-wa-archive

## Project Overview

OpenClaw plugin that archives ALL WhatsApp messages (inbound + outbound) into a SQLite database with full-text search (FTS5) and semantic/vector search. Provides query tools so the AI agent can search across all conversations, groups, and sessions.

## Architecture

This is an **OpenClaw plugin** (TypeScript, loaded via jiti at runtime).

### What the plugin does:

1. **Message Interception** — Registers hooks on `message:received`, `message:sent`, and `message:preprocessed` events to capture every WhatsApp message
2. **Storage** — Stores messages in SQLite with full metadata
3. **Embeddings** — Generates OpenAI embeddings for semantic search (async, non-blocking)
4. **Media** — Downloads and stores media files locally, saves local path in DB
5. **Query Tools** — Registers agent tools (`wa_search`, `wa_stats`) for searching the archive
6. **Backfill** — CLI command or startup routine to import existing JSONL session transcripts

### Tech Stack

- **SQLite** via `better-sqlite3` (synchronous, fast, single file)
- **FTS5** for full-text search (built into SQLite)
- **sqlite-vec** for vector similarity search (npm: `sqlite-vec`)
- **OpenAI** `text-embedding-3-small` for generating embeddings

## File Structure

```
openclaw-wa-archive/
├── package.json
├── tsconfig.json
├── openclaw.plugin.json          # Plugin manifest
├── .gitignore
├── AGENTS.md
├── README.md
├── src/
│   ├── index.ts                  # Plugin entry — register() function
│   ├── db.ts                     # SQLite setup, migrations, helpers
│   ├── schema.sql                # SQL schema (reference, actual creation in db.ts)
│   ├── embeddings.ts             # OpenAI embedding generation
│   ├── ingest.ts                 # Message event → DB row
│   ├── media.ts                  # Media download + local storage
│   ├── tools/
│   │   ├── wa-search.ts          # wa_search tool implementation
│   │   └── wa-stats.ts           # wa_stats tool implementation
│   └── backfill.ts               # Import existing JSONL transcripts
└── data/                         # Created at runtime (gitignored)
    ├── messages.db               # SQLite database
    └── media/                    # Downloaded media files
```

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,              -- WhatsApp message ID (or generated UUID for outbound)
  session_key TEXT,                 -- OpenClaw session key
  chat_id TEXT NOT NULL,            -- WhatsApp chat ID (group ID or phone number)
  chat_type TEXT NOT NULL,          -- 'group' or 'direct'
  chat_name TEXT,                   -- Group name or contact display name
  sender_id TEXT,                   -- Sender phone/LID
  sender_name TEXT,                 -- Sender display name
  timestamp INTEGER NOT NULL,       -- Unix timestamp (milliseconds)
  content TEXT,                     -- Full message text
  media_local_path TEXT,            -- Local path to downloaded media
  media_url TEXT,                   -- Original media URL
  media_type TEXT,                  -- MIME type or category (image/video/audio/document)
  reply_to_id TEXT,                 -- Quoted/replied message ID
  is_from_me INTEGER DEFAULT 0,    -- 1 if sent by the bot, 0 if received
  direction TEXT DEFAULT 'inbound', -- 'inbound' or 'outbound'
  channel TEXT DEFAULT 'whatsapp',  -- Channel identifier
  account_id TEXT,                  -- WhatsApp account ID
  metadata TEXT,                    -- JSON blob for any extra metadata
  created_at INTEGER NOT NULL       -- When this row was inserted (Unix ms)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_messages_chat_type ON messages(chat_type);

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Vector embeddings table (sqlite-vec)
-- Created programmatically via sqlite-vec API:
-- CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
--   message_rowid INTEGER PRIMARY KEY,
--   embedding float[1536]
-- );
```

## Plugin Entry (src/index.ts)

```typescript
export function register(api: any) {
  // 1. Initialize DB (create tables if needed)
  // 2. Register message hooks:
  //    - api.registerHook('message:received', handler)
  //    - api.registerHook('message:sent', handler)  
  //    - api.registerHook('message:preprocessed', handler) // for transcribed content
  // 3. Register tools:
  //    - wa_search (with allowFrom restriction)
  //    - wa_stats (with allowFrom restriction)
  // 4. Register CLI command for backfill:
  //    - api.registerCommand({ name: 'wa-backfill', ... })
  // 5. Optionally run backfill on first startup
}
```

## Plugin Manifest (openclaw.plugin.json)

```json
{
  "id": "wa-archive",
  "name": "WhatsApp Archive",
  "description": "Archives all WhatsApp messages with full-text and semantic search",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "dataDir": {
        "type": "string",
        "description": "Directory for database and media files (default: plugin data/ dir)"
      },
      "enableEmbeddings": {
        "type": "boolean",
        "description": "Enable semantic/vector search via OpenAI embeddings (default: true)"
      },
      "embeddingModel": {
        "type": "string",
        "description": "OpenAI embedding model (default: text-embedding-3-small)"
      },
      "mediaDownload": {
        "type": "boolean",
        "description": "Download and store media files locally (default: true)"
      },
      "allowFrom": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Phone numbers allowed to use search tools (default: owner only)"
      }
    }
  }
}
```

## Message Hooks Implementation (src/ingest.ts)

For `message:received`:
- Extract from event.context: `from`, `content`, `timestamp`, `channelId`, `accountId`, `conversationId`, `messageId`, `metadata` (senderName, senderE164, etc.)
- Only process if channelId === 'whatsapp'
- Determine chat_type from metadata (isGroup, groupId) or conversationId format
- Insert into messages table
- Queue embedding generation (fire-and-forget async)
- If media present, queue media download

For `message:sent`:
- Extract from event.context: `to`, `content`, `success`, `channelId`, `accountId`, `conversationId`, `messageId`, `isGroup`, `groupId`
- Only process if channelId === 'whatsapp' and success === true
- Insert with is_from_me=1, direction='outbound'
- Queue embedding generation

For `message:preprocessed`:
- Use this to UPDATE existing received messages with enriched content (transcripts, link summaries)
- Match by messageId, update content field

## Tools Implementation

### wa_search

Parameters:
- `query` (string, required) — Search query (natural language or keywords)
- `sender` (string, optional) — Filter by sender name or phone number
- `chat` (string, optional) — Filter by chat/group name or ID
- `chat_type` (string, optional) — 'group' or 'direct'
- `from_date` (string, optional) — Start date (ISO 8601 or relative like "2 days ago")
- `to_date` (string, optional) — End date
- `mode` (string, optional) — 'fts' (full-text), 'semantic' (vector), 'hybrid' (both, default)
- `limit` (number, optional, default 20) — Max results

Logic:
1. Parse dates (support relative dates like "yesterday", "last week", "2 days ago")
2. If mode includes 'fts': run FTS5 query on messages_fts
3. If mode includes 'semantic': generate embedding for query, run sqlite-vec similarity search
4. If 'hybrid': merge and deduplicate results, rank by combined score
5. Apply sender/chat/date filters as SQL WHERE clauses
6. Return results with: sender_name, chat_name, timestamp, content snippet, message_id

### wa_stats

Parameters:
- `period` (string, optional) — 'today', 'week', 'month', 'all' (default: 'week')
- `chat` (string, optional) — Filter by specific chat
- `sender` (string, optional) — Filter by specific sender

Returns:
- Total messages in period
- Messages per chat (top 10)
- Messages per sender (top 10)
- Busiest hours
- Inbound vs outbound ratio

## Backfill (src/backfill.ts)

Scans all JSONL session transcript files in `~/.openclaw/agents/main/sessions/`.

For each `.jsonl` file:
1. Read line by line
2. Parse each JSON line
3. Extract user messages (role: 'user') — these are inbound
4. Extract assistant messages with tool calls to `message` action='send' — these are outbound
5. Map to the messages table schema as best as possible
6. Skip if message ID already exists (idempotent)
7. Generate embeddings in batches (batch OpenAI calls, ~100 at a time)

Session key can be derived from the sessions.json mapping file.

## Embeddings (src/embeddings.ts)

- Use OpenAI API with `text-embedding-3-small` (1536 dimensions)
- API key: read from environment `OPENAI_API_KEY` or from OpenClaw config
- Batch processing: collect messages in a queue, process in batches of up to 100
- Rate limiting: respect OpenAI rate limits, use exponential backoff
- Non-blocking: embedding generation should never block message processing
- On failure: log warning, leave embedding null (can be retried later)

## Media Download (src/media.ts)

- Download media from WhatsApp URLs to local `data/media/` directory
- Organize by date: `data/media/YYYY/MM/DD/`
- Filename: `{message_id}_{original_filename_or_hash}.{ext}`
- Support: images, videos, audio, documents
- Max file size: respect `channels.whatsapp.mediaMaxMb` config (currently 50MB)
- Update `media_local_path` in DB after download
- Non-blocking: download in background

## Access Control

The query tools (wa_search, wa_stats) should ONLY be available to authorized users.

In the tool registration, check the sender against the `allowFrom` config or against OpenClaw's `tools.elevated.allowFrom.whatsapp` list.

Default: only the owner (+972547552872) can query.

## Important Implementation Notes

1. **Plugin API**: Use `api.registerHook(eventName, handler, options)` for hooks and `api.registerTool({...})` for tools — follow the pattern from the openclaw-monday plugin
2. **Data directory**: Default to `~/.openclaw/data/wa-archive/` (not inside the plugin source dir)
3. **Graceful degradation**: If sqlite-vec fails to load, fall back to FTS-only search. If OpenAI API is unavailable, skip embeddings but still store messages.
4. **Idempotent inserts**: Use `INSERT OR IGNORE` to prevent duplicate messages
5. **Performance**: Use WAL mode for SQLite, batch inserts during backfill
6. **Error handling**: Never crash on a single message failure. Log errors, continue processing.

## Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.11.0",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

Note: OpenAI API calls should be done with plain fetch() — no SDK dependency needed.

## Config in openclaw.json

After building, the plugin will be loaded via:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/Users/diegomalamute/development/openclaw-monday/packages/openclaw-plugin",
        "/Users/diegomalamute/development/openclaw-wa-archive"
      ]
    },
    "entries": {
      "wa-archive": {
        "enabled": true,
        "config": {
          "dataDir": "~/.openclaw/data/wa-archive",
          "enableEmbeddings": true,
          "mediaDownload": true,
          "allowFrom": ["+972547552872"]
        }
      }
    }
  }
}
```
