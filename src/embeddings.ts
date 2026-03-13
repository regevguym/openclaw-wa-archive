import { getDb, getMessageRowid, isVecEnabled } from './db';

const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = 2000;

interface EmbeddingQueueItem {
  messageId: string;
  content: string;
}

let queue: EmbeddingQueueItem[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let apiKey: string | null = null;
let model = 'text-embedding-3-small';
let enabled = true;

export function configureEmbeddings(opts: {
  apiKey?: string;
  model?: string;
  enabled?: boolean;
}): void {
  if (opts.apiKey) apiKey = opts.apiKey;
  if (opts.model) model = opts.model;
  if (opts.enabled !== undefined) enabled = opts.enabled;
}

export function queueEmbedding(messageId: string, content: string): void {
  if (!enabled || !isVecEnabled() || !content?.trim()) return;

  queue.push({ messageId, content });

  if (queue.length >= BATCH_SIZE) {
    flushQueue();
  } else if (!batchTimer) {
    batchTimer = setTimeout(() => flushQueue(), BATCH_INTERVAL_MS);
  }
}

async function flushQueue(): Promise<void> {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  if (queue.length === 0) return;

  const batch = queue.splice(0, BATCH_SIZE);
  try {
    await processBatch(batch);
  } catch (err) {
    console.warn('[wa-archive] Embedding batch failed:', (err as Error).message);
  }

  // If there are remaining items, schedule another flush
  if (queue.length > 0) {
    batchTimer = setTimeout(() => flushQueue(), BATCH_INTERVAL_MS);
  }
}

async function processBatch(batch: EmbeddingQueueItem[]): Promise<void> {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('[wa-archive] No OpenAI API key available, skipping embeddings');
    return;
  }

  const texts = batch.map((item) => item.content);
  const embeddings = await fetchEmbeddings(key, texts);

  if (!embeddings || embeddings.length !== batch.length) {
    console.warn('[wa-archive] Embedding response mismatch, skipping batch');
    return;
  }

  const db = getDb();
  const insertVec = db.prepare(
    'INSERT OR REPLACE INTO messages_vec (message_rowid, embedding) VALUES (CAST(? AS INTEGER), ?)'
  );

  const transaction = db.transaction(() => {
    for (let i = 0; i < batch.length; i++) {
      const rowid = getMessageRowid(batch[i].messageId);
      if (rowid == null) continue;

      const embedding = embeddings[i];
      const buffer = new Float32Array(embedding).buffer;
      insertVec.run(rowid, Buffer.from(buffer));
    }
  });

  transaction();
}

async function fetchEmbeddings(
  key: string,
  texts: string[],
  retries = 3
): Promise<number[][] | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (response.status === 429) {
        // Rate limited — exponential backoff
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`[wa-archive] Rate limited, retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        console.warn(`[wa-archive] OpenAI API error ${response.status}: ${body}`);
        return null;
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to ensure correct order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err) {
      if (attempt < retries - 1) {
        const wait = Math.pow(2, attempt) * 1000;
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  return null;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return null;

  const result = await fetchEmbeddings(key, [text]);
  return result ? result[0] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
