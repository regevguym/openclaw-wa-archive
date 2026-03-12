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
