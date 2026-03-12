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

  // Create FTS5 virtual table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid'
    );
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

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

export function insertBatch(messages: MessageRow[]): void {
  const transaction = getDb().transaction((msgs: MessageRow[]) => {
    for (const msg of msgs) {
      insertMessage(msg);
    }
  });
  transaction(messages);
}
