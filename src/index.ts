import path from 'path';
import { initDb, closeDb } from './db';
import { configureEmbeddings } from './embeddings';
import { configureMedia } from './media';
import { handleMessageReceived, handleMessageSent, handleMessagePreprocessed } from './ingest';
import { buildWaSearchTool } from './tools/wa-search';
import { buildWaStatsTool } from './tools/wa-stats';
import { runBackfill } from './backfill';

export function register(api: any) {
  const config = api.getConfig?.() || {};
  const dataDir = config.dataDir
    ? config.dataDir.replace('~', process.env.HOME || '')
    : path.join(process.env.HOME || '', '.openclaw', 'data', 'wa-archive');

  // 1. Initialize database
  try {
    initDb(dataDir);
  } catch (err) {
    console.error('[wa-archive] Failed to initialize database:', err);
    return;
  }

  // 2. Configure embeddings
  const enableEmbeddings = config.enableEmbeddings !== false;
  configureEmbeddings({
    apiKey: config.openaiApiKey || process.env.OPENAI_API_KEY,
    model: config.embeddingModel || 'text-embedding-3-small',
    enabled: enableEmbeddings,
  });

  // 3. Configure media
  if (config.mediaDownload !== false) {
    configureMedia(dataDir);
  }

  // 4. Register message hooks (use api.on for typed hooks)
  api.on('message_received', handleMessageReceived);
  api.on('message_sent', handleMessageSent);
  api.on('message_preprocessed', handleMessagePreprocessed);

  // 5. Register tools
  const allowFrom = config.allowFrom || ['+972547552872'];

  api.registerTool(buildWaSearchTool(allowFrom));
  api.registerTool(buildWaStatsTool(allowFrom));

  // 6. Register backfill command
  api.registerCommand?.({
    name: 'wa-backfill',
    description: 'Import existing JSONL session transcripts into the WhatsApp archive',
    execute: async () => {
      console.log('[wa-archive] Starting backfill...');
      const result = await runBackfill();
      return `Backfill complete: ${result.imported} imported, ${result.skipped} skipped`;
    },
  });

  // 7. Register cleanup on shutdown
  api.registerHook?.('shutdown', () => {
    closeDb();
  }, {
    name: 'wa-archive:shutdown',
  });

  console.log('[wa-archive] Plugin loaded successfully');
}
