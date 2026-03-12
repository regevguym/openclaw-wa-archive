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
  // Try both locations for sessions.json
  const sessionsMapPath = fs.existsSync(path.join(sessionsDir, 'sessions.json'))
    ? path.join(sessionsDir, 'sessions.json')
    : path.join(sessionsDir, '..', 'sessions.json');
  let sessionsMap: Record<string, any> = {};
  if (fs.existsSync(sessionsMapPath)) {
    try {
      sessionsMap = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  // Build reverse map: sessionId -> { sessionKey, meta }
  const idToMeta: Record<string, { sessionKey: string; meta: any }> = {};
  for (const [key, meta] of Object.entries(sessionsMap)) {
    const m = meta as any;
    if (m?.sessionId) {
      idToMeta[m.sessionId] = { sessionKey: key, meta: m };
    }
  }

  // Find all .jsonl files (skip sessions.json)
  const files = fs.readdirSync(sessionsDir).filter(
    (f) => f.endsWith('.jsonl') && f !== 'sessions.json'
  );

  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    const sessionId = file.replace('.jsonl', '');
    const mapped = idToMeta[sessionId];
    const sessionKey = mapped?.sessionKey || sessionId;
    const sessionMeta = mapped?.meta || null;

    // Only process WhatsApp sessions for now
    if (sessionMeta && sessionMeta.channel !== 'whatsapp' && !sessionKey.includes('whatsapp')) {
      skipped++;
      continue;
    }

    try {
      const result = await processSessionFile(filePath, sessionKey, sessionMeta);
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

  // Derive chat info from session key and metadata
  // Session keys look like: agent:main:whatsapp:group:120363406381938883@g.us
  //                     or: agent:main:whatsapp:direct:+972547552872
  const keyParts = sessionKey.split(':');
  const chatType = sessionMeta?.chatType || (keyParts[3] === 'group' ? 'group' : 'direct');
  const chatId = sessionMeta?.groupId || keyParts[4] || sessionMeta?.conversationId || sessionKey;
  const chatName = sessionMeta?.subject || sessionMeta?.displayName || sessionMeta?.contactName || null;
  const accountId = sessionMeta?.accountId || null;

  // For DM sessions, try to extract peer phone from session key
  const peerPhone = chatType === 'direct' && keyParts[4] ? keyParts[4] : null;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }

    // OpenClaw JSONL transcript format: { type: "message", message: { role, content, ... }, timestamp }
    // Extract the inner message object
    const msg = entry.type === 'message' ? entry.message : entry;
    const entryTimestamp = entry.timestamp
      ? new Date(entry.timestamp).getTime()
      : msg?.timestamp
        ? new Date(msg.timestamp).getTime()
        : Date.now();

    if (!msg || !msg.role) {
      skipped++;
      continue;
    }

    // Process user messages (inbound)
    if (msg.role === 'user' && msg.content) {
      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n')
            : null;

      if (textContent) {
        const msgId = entry.id || msg.id || msg.messageId || randomUUID();
        batch.push({
          id: msgId,
          session_key: sessionKey,
          chat_id: chatId,
          chat_type: chatType,
          chat_name: chatName,
          sender_id: sessionMeta?.senderE164 || null,
          sender_name: sessionMeta?.senderName || null,
          timestamp: entryTimestamp,
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

    // Process assistant messages (outbound) — both direct text replies and tool calls
    if (msg.role === 'assistant') {
      // Direct text content from assistant
      if (msg.content) {
        const textContent =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.text)
                  .join('\n')
              : null;

        if (textContent && textContent.trim() && textContent !== 'NO_REPLY' && textContent !== 'HEARTBEAT_OK') {
          const msgId = entry.id || msg.id || randomUUID();
          batch.push({
            id: `out-${msgId}`,
            session_key: sessionKey,
            chat_id: chatId,
            chat_type: chatType,
            chat_name: chatName,
            sender_id: null,
            sender_name: 'Nymeria',
            timestamp: entryTimestamp,
            content: textContent,
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

      // Tool calls with message send
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
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

            if (args.action === 'send' && (args.message || args.content)) {
              const msgContent = args.message || args.content;
              const msgId = tc.id || randomUUID();
              batch.push({
                id: `tool-${msgId}`,
                session_key: sessionKey,
                chat_id: chatId,
                chat_type: chatType,
                chat_name: chatName,
                sender_id: null,
                sender_name: 'Nymeria',
                timestamp: entryTimestamp,
                content: msgContent,
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
