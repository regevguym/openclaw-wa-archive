import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { insertBatch, MessageRow } from './db';
import { queueEmbedding } from './embeddings';

const SESSIONS_DIR = path.join(
  process.env.HOME || '~',
  '.openclaw',
  'agents',
  'main',
  'sessions'
);

export async function runBackfill(opts?: { sessionsDir?: string }): Promise<{ imported: number; skipped: number }> {
  const sessionsDir = opts?.sessionsDir || SESSIONS_DIR;
  let imported = 0;
  let skipped = 0;

  if (!fs.existsSync(sessionsDir)) {
    console.warn(`[wa-archive] Sessions directory not found: ${sessionsDir}`);
    return { imported: 0, skipped: 0 };
  }

  // Try to load sessions mapping
  const sessionsMapPath = path.join(sessionsDir, '..', 'sessions.json');
  let sessionsMap: Record<string, any> = {};
  if (fs.existsSync(sessionsMapPath)) {
    try {
      sessionsMap = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  // Find all .jsonl files
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    const sessionKey = file.replace('.jsonl', '');

    try {
      const result = await processSessionFile(filePath, sessionKey, sessionsMap[sessionKey]);
      imported += result.imported;
      skipped += result.skipped;
    } catch (err) {
      console.error(`[wa-archive] Error processing ${file}:`, err);
    }
  }

  console.log(`[wa-archive] Backfill complete: ${imported} imported, ${skipped} skipped`);
  return { imported, skipped };
}

async function processSessionFile(
  filePath: string,
  sessionKey: string,
  sessionMeta?: any
): Promise<{ imported: number; skipped: number }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  const batch: MessageRow[] = [];
  let imported = 0;
  let skipped = 0;

  // Derive chat info from session metadata if available
  const chatId = sessionMeta?.conversationId || sessionMeta?.chatId || sessionKey;
  const chatType = sessionMeta?.isGroup ? 'group' : 'direct';
  const chatName = sessionMeta?.groupName || sessionMeta?.contactName || null;
  const accountId = sessionMeta?.accountId || null;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }

    // Process user messages (inbound)
    if (entry.role === 'user' && entry.content) {
      const textContent =
        typeof entry.content === 'string'
          ? entry.content
          : Array.isArray(entry.content)
            ? entry.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n')
            : null;

      if (textContent) {
        const msgId = entry.id || entry.messageId || randomUUID();
        batch.push({
          id: msgId,
          session_key: sessionKey,
          chat_id: chatId,
          chat_type: chatType,
          chat_name: chatName,
          sender_id: sessionMeta?.senderE164 || null,
          sender_name: sessionMeta?.senderName || null,
          timestamp: entry.timestamp || Date.now(),
          content: textContent,
          media_local_path: null,
          media_url: null,
          media_type: null,
          reply_to_id: null,
          is_from_me: 0,
          direction: 'inbound',
          channel: 'whatsapp',
          account_id: accountId,
          metadata: null,
          created_at: Date.now(),
        });
        imported++;
      }
    }

    // Process assistant messages with send tool calls (outbound)
    if (entry.role === 'assistant' && entry.tool_calls) {
      for (const tc of entry.tool_calls) {
        if (
          tc.function?.name === 'message' &&
          tc.function?.arguments
        ) {
          let args: any;
          try {
            args =
              typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
          } catch {
            continue;
          }

          if (args.action === 'send' && args.content) {
            const msgId = tc.id || randomUUID();
            batch.push({
              id: msgId,
              session_key: sessionKey,
              chat_id: chatId,
              chat_type: chatType,
              chat_name: chatName,
              sender_id: null,
              sender_name: null,
              timestamp: entry.timestamp || Date.now(),
              content: args.content,
              media_local_path: null,
              media_url: null,
              media_type: null,
              reply_to_id: null,
              is_from_me: 1,
              direction: 'outbound',
              channel: 'whatsapp',
              account_id: accountId,
              metadata: null,
              created_at: Date.now(),
            });
            imported++;
          }
        }
      }
    }

    // Insert in batches of 100
    if (batch.length >= 100) {
      insertBatch(batch.splice(0, 100));
    }
  }

  // Insert remaining
  if (batch.length > 0) {
    const remaining = batch.splice(0);
    insertBatch(remaining);

    // Queue embeddings for remaining batch
    for (const msg of remaining) {
      if (msg.content) {
        queueEmbedding(msg.id, msg.content);
      }
    }
  }

  return { imported, skipped };
}
