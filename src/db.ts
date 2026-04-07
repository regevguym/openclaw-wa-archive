import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database.Database | null = null;
let vecEnabled = false;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function isVecEnabled(): boolean {
  return vecEnabled;
}

export function initDb(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'messages.db');
  db = new Database(dbPath);

  // Enable WAL mode for performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      chat_name TEXT,
      sender_id TEXT,
      sender_name TEXT,
      timestamp INTEGER NOT NULL,
      content TEXT,
      media_local_path TEXT,
      media_url TEXT,
      media_type TEXT,
      reply_to_id TEXT,
      is_from_me INTEGER DEFAULT 0,
      direction TEXT DEFAULT 'inbound',
      channel TEXT DEFAULT 'whatsapp',
      account_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_type ON messages(chat_type);
  `);

  // Create FTS5 virtual table (with sender_name + chat_name for richer search)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      sender_name,
      chat_name,
      content='messages',
      content_rowid='rowid'
    );
  `);

  // Migration: if FTS exists but lacks sender_name/chat_name columns, rebuild it
  try {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);
    // Quick probe: try a dummy query referencing sender_name
    db.prepare(`SELECT rowid FROM messages_fts WHERE sender_name MATCH 'probe' LIMIT 0`).all();
  } catch {
    // FTS schema mismatch — rebuild
    console.log('[wa-archive] Rebuilding FTS table to add sender_name + chat_name columns...');
    db.exec(`DROP TRIGGER IF EXISTS messages_ai`);
    db.exec(`DROP TRIGGER IF EXISTS messages_ad`);
    db.exec(`DROP TRIGGER IF EXISTS messages_au`);
    db.exec(`DROP TABLE IF EXISTS messages_fts`);
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        sender_name,
        chat_name,
        content='messages',
        content_rowid='rowid'
      );
    `);
    db.exec(`
      INSERT INTO messages_fts(rowid, content, sender_name, chat_name)
      SELECT rowid, content, sender_name, chat_name FROM messages;
    `);
    console.log('[wa-archive] FTS rebuild complete');
  }

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, sender_name, chat_name) VALUES (new.rowid, new.content, new.sender_name, new.chat_name);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, sender_name, chat_name) VALUES('delete', old.rowid, old.content, old.sender_name, old.chat_name);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, sender_name, chat_name) VALUES('delete', old.rowid, old.content, old.sender_name, old.chat_name);
      INSERT INTO messages_fts(rowid, content, sender_name, chat_name) VALUES (new.rowid, new.content, new.sender_name, new.chat_name);
    END;
  `);

  // Add token usage columns (migration — safe to run multiple times)
  const cols = (db.pragma('table_info(messages)') as any[]).map((c: any) => c.name);
  if (!cols.includes('input_tokens')) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN input_tokens INTEGER DEFAULT NULL;
      ALTER TABLE messages ADD COLUMN output_tokens INTEGER DEFAULT NULL;
      ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER DEFAULT NULL;
      ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER DEFAULT NULL;
      ALTER TABLE messages ADD COLUMN total_tokens INTEGER DEFAULT NULL;
      ALTER TABLE messages ADD COLUMN cost_usd REAL DEFAULT NULL;
    `);
  }

  // Try to load sqlite-vec extension
  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    vecEnabled = true;

    // Create vector table for embeddings (1536 dimensions for text-embedding-3-small)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
        message_rowid INTEGER PRIMARY KEY,
        embedding float[1536]
      );
    `);
  } catch (err) {
    console.warn('[wa-archive] sqlite-vec not available, vector search disabled:', (err as Error).message);
    vecEnabled = false;
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Prepared statement cache
const stmtCache = new Map<string, Database.Statement>();

function getStmt(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

export interface MessageRow {
  id: string;
  session_key?: string | null;
  chat_id: string;
  chat_type: string;
  chat_name?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
  timestamp: number;
  content?: string | null;
  media_local_path?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  reply_to_id?: string | null;
  is_from_me: number;
  direction: string;
  channel: string;
  account_id?: string | null;
  metadata?: string | null;
  created_at: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  total_tokens?: number | null;
  cost_usd?: number | null;
}

export function insertMessage(msg: MessageRow): void {
  const sql = `
    INSERT OR IGNORE INTO messages (
      id, session_key, chat_id, chat_type, chat_name,
      sender_id, sender_name, timestamp, content,
      media_local_path, media_url, media_type, reply_to_id,
      is_from_me, direction, channel, account_id, metadata, created_at
    ) VALUES (
      @id, @session_key, @chat_id, @chat_type, @chat_name,
      @sender_id, @sender_name, @timestamp, @content,
      @media_local_path, @media_url, @media_type, @reply_to_id,
      @is_from_me, @direction, @channel, @account_id, @metadata, @created_at
    )
  `;
  getStmt(sql).run({
    id: msg.id,
    session_key: msg.session_key ?? null,
    chat_id: msg.chat_id,
    chat_type: msg.chat_type,
    chat_name: msg.chat_name ?? null,
    sender_id: msg.sender_id ?? null,
    sender_name: msg.sender_name ?? null,
    timestamp: msg.timestamp,
    content: msg.content ?? null,
    media_local_path: msg.media_local_path ?? null,
    media_url: msg.media_url ?? null,
    media_type: msg.media_type ?? null,
    reply_to_id: msg.reply_to_id ?? null,
    is_from_me: msg.is_from_me,
    direction: msg.direction,
    channel: msg.channel,
    account_id: msg.account_id ?? null,
    metadata: msg.metadata ?? null,
    created_at: msg.created_at,
  });
}

export function updateMessageContent(messageId: string, content: string): void {
  const sql = `UPDATE messages SET content = @content WHERE id = @id`;
  getStmt(sql).run({ id: messageId, content });
}

export function updateMediaPath(messageId: string, localPath: string): void {
  const sql = `UPDATE messages SET media_local_path = @path WHERE id = @id`;
  getStmt(sql).run({ id: messageId, path: localPath });
}

export function getMessageRowid(messageId: string): number | null {
  const sql = `SELECT rowid FROM messages WHERE id = @id`;
  const row = getStmt(sql).get({ id: messageId }) as { rowid: number } | undefined;
  return row?.rowid ?? null;
}

export interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
}

export function updateMessageUsage(messageId: string, usage: UsageData): void {
  const sql = `
    UPDATE messages SET
      input_tokens = @input_tokens,
      output_tokens = @output_tokens,
      cache_read_tokens = @cache_read_tokens,
      cache_write_tokens = @cache_write_tokens,
      total_tokens = @total_tokens,
      cost_usd = @cost_usd
    WHERE id = @id
  `;
  getStmt(sql).run({
    id: messageId,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_read_tokens: usage.cache_read_tokens ?? null,
    cache_write_tokens: usage.cache_write_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    cost_usd: usage.cost_usd ?? null,
  });
}

export function insertBatch(messages: MessageRow[]): void {
  const transaction = getDb().transaction((msgs: MessageRow[]) => {
    for (const msg of msgs) {
      insertMessage(msg);
    }
  });
  transaction(messages);
}
