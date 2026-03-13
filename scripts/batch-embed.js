#!/usr/bin/env node
/**
 * Batch embedding script for all messages without embeddings.
 * Processes messages in batches of 50, with rate limiting.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = path.join(process.env.HOME, '.openclaw', 'data', 'wa-archive');
const DB_PATH = path.join(DATA_DIR, 'messages.db');
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 50;
const DELAY_MS = 1000;

if (!API_KEY) {
  console.error('OPENAI_API_KEY not set');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Load sqlite-vec
try {
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(db);
} catch (err) {
  console.error('Failed to load sqlite-vec:', err.message);
  process.exit(1);
}

// Ensure vec table exists
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
    message_rowid INTEGER PRIMARY KEY,
    embedding float[1536]
  );
`);

async function fetchEmbeddings(texts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ model: MODEL, input: texts }),
      });

      if (response.status === 429) {
        const wait = Math.pow(2, attempt + 1) * 2000;
        console.warn(`  Rate limited, waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        console.error(`  API error ${response.status}: ${body.slice(0, 200)}`);
        return null;
      }

      const data = await response.json();
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    } catch (err) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw err;
    }
  }
  return null;
}

// Strip metadata envelope from content for cleaner embeddings
function cleanContent(content) {
  if (!content) return '';
  // Remove the "Conversation info" and "Sender" JSON blocks
  const parts = content.split('```');
  if (parts.length >= 5) {
    // Take everything after the last ``` block
    return parts.slice(4).join('```').trim();
  }
  if (parts.length >= 3) {
    return parts.slice(2).join('```').trim();
  }
  return content.trim();
}

async function main() {
  // Get all messages that don't have embeddings yet
  const existingRowids = new Set(
    db.prepare('SELECT message_rowid FROM messages_vec').all().map(r => r.message_rowid)
  );

  const allMessages = db.prepare(`
    SELECT rowid, id, content FROM messages 
    WHERE content IS NOT NULL AND content != ''
    ORDER BY timestamp ASC
  `).all();

  const needsEmbedding = allMessages.filter(m => !existingRowids.has(m.rowid));

  console.log(`Total messages: ${allMessages.length}`);
  console.log(`Already embedded: ${existingRowids.size}`);
  console.log(`Needs embedding: ${needsEmbedding.length}`);

  if (needsEmbedding.length === 0) {
    console.log('All messages already have embeddings!');
    return;
  }

  const insertVec = db.prepare(
    'INSERT OR REPLACE INTO messages_vec (message_rowid, embedding) VALUES (CAST(? AS INTEGER), ?)'
  );

  let processed = 0;
  let errors = 0;
  let totalTokens = 0;

  for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
    const batch = needsEmbedding.slice(i, i + BATCH_SIZE);
    const texts = batch.map(m => {
      const cleaned = cleanContent(m.content);
      // Truncate very long messages (embedding limit ~8191 tokens)
      return cleaned.slice(0, 8000);
    });

    const embeddings = await fetchEmbeddings(texts);

    if (!embeddings || embeddings.length !== batch.length) {
      console.error(`  Batch ${Math.floor(i/BATCH_SIZE) + 1} failed, skipping ${batch.length} messages`);
      errors += batch.length;
      await new Promise(r => setTimeout(r, DELAY_MS * 2));
      continue;
    }

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const buffer = Buffer.from(new Float32Array(embeddings[j]).buffer);
        insertVec.run(Number(batch[j].rowid), buffer);
      }
    });
    tx();

    processed += batch.length;
    const pct = ((processed + errors) / needsEmbedding.length * 100).toFixed(1);
    console.log(`  Batch ${Math.floor(i/BATCH_SIZE) + 1}: embedded ${batch.length} messages (${pct}% done, ${processed} ok, ${errors} errors)`);

    // Rate limit delay
    if (i + BATCH_SIZE < needsEmbedding.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone! Embedded: ${processed}, Errors: ${errors}, Total: ${processed + errors}`);

  // Verify
  const vecCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_vec').get();
  console.log(`Total embeddings in DB: ${vecCount.cnt}`);
}

main().then(() => {
  db.close();
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  db.close();
  process.exit(1);
});
