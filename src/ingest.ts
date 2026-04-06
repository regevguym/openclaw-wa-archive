import { randomUUID } from 'crypto';
import { insertMessage, updateMessageContent } from './db';
import { queueEmbedding } from './embeddings';
import { queueMediaDownload } from './media';
import { attachUsageToMessage } from './costs';

let outboundSenderName = 'Me';

export function setOutboundSenderName(name: string): void {
  outboundSenderName = name;
}

/** Channels we archive. Add new channels here to extend coverage. */
const SUPPORTED_CHANNELS = new Set(['whatsapp', 'slack']);

/** Derive whether a chat ID represents a group */
function deriveIsGroup(chatId: string | undefined, metadata: any, ctx: any): boolean {
  if (metadata.isGroup === true || ctx.isGroup === true) return true;
  if (chatId && chatId.endsWith('@g.us')) return true; // WhatsApp groups
  // Slack: channels (C*) are group-like, DMs (D*) are direct
  if (chatId && /^C[A-Z0-9]+$/.test(chatId)) return true;
  return false;
}

/** Resolve the chat ID from event context */
function resolveChatId(ctx: any, metadata: any, fallback: string | undefined): string {
  return metadata.groupId || metadata.originatingTo || ctx.conversationId || fallback || '';
}

/** Resolve chat name from all available metadata fields */
function resolveChatName(metadata: any, ctx: any): string | null {
  return metadata.groupName || metadata.groupSubject || metadata.subject
    || ctx.groupName || ctx.groupSubject || ctx.subject
    || metadata.contactName || ctx.contactName || null;
}

export function handleMessageReceived(event: any): void {
  try {
    const ctx = event?.context || event;
    const metadata = ctx.metadata || event.metadata || {};
    const channelId = ctx.channelId || ctx.channel || metadata.channel || metadata.provider || 'whatsapp';
    // Skip channels we don't archive
    if (channelId && !SUPPORTED_CHANNELS.has(channelId)) return;

    const messageId = ctx.messageId || ctx.id || event.messageId || randomUUID();
    const chatId = resolveChatId(ctx, metadata, ctx.from || event.from);
    const isGroup = deriveIsGroup(chatId, metadata, ctx);
    const chatType = isGroup ? 'group' : 'direct';

    insertMessage({
      id: messageId,
      session_key: ctx.sessionKey || event.sessionKey || null,
      chat_id: chatId,
      chat_type: chatType,
      chat_name: resolveChatName(metadata, ctx),
      sender_id: metadata.senderE164 || ctx.from || event.from || null,
      sender_name: metadata.senderName || metadata.pushName || null,
      timestamp: ctx.timestamp || event.timestamp || Date.now(),
      content: ctx.content || ctx.body || event.content || null,
      media_local_path: null,
      media_url: metadata.mediaUrl || null,
      media_type: metadata.mediaType || null,
      reply_to_id: metadata.quotedMessageId || null,
      is_from_me: 0,
      direction: 'inbound',
      channel: channelId || 'whatsapp',
      account_id: ctx.accountId || null,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      created_at: Date.now(),
    });

    // Queue embedding generation
    const content = ctx.content || ctx.body;
    if (content) {
      queueEmbedding(messageId, content);
    }

    // Queue media download if present
    if (metadata.mediaUrl) {
      queueMediaDownload(messageId, metadata.mediaUrl, metadata.mediaType);
    }
  } catch (err) {
    console.error('[wa-archive] Error processing received message:', err);
  }
}

/**
 * Handle outbound messages via message_sent (api.on legacy path).
 * Kept for backward compatibility — message_sending hook is the primary capture path.
 */
export function handleMessageSent(event: any): void {
  try {
    const ctx = event?.context || event;
    const metadata = ctx.metadata || event.metadata || {};
    const channelId = ctx.channelId || ctx.channel || metadata.channel || metadata.provider || 'whatsapp';
    if (channelId && !SUPPORTED_CHANNELS.has(channelId)) return;
    if (ctx.success === false) return;

    const messageId = ctx.messageId || ctx.id || event.messageId || randomUUID();
    const chatId = resolveChatId(ctx, metadata, ctx.to || event.to);
    const isGroup = deriveIsGroup(chatId, metadata, ctx);
    const chatType = isGroup ? 'group' : 'direct';

    // INSERT OR IGNORE — if message_sending already captured this, skip
    insertMessage({
      id: messageId,
      session_key: ctx.sessionKey || event.sessionKey || null,
      chat_id: chatId,
      chat_type: chatType,
      chat_name: resolveChatName(metadata, ctx),
      sender_id: null,
      sender_name: outboundSenderName,
      timestamp: ctx.timestamp || event.timestamp || Date.now(),
      content: ctx.content || ctx.body || event.content || null,
      media_local_path: null,
      media_url: null,
      media_type: null,
      reply_to_id: null,
      is_from_me: 1,
      direction: 'outbound',
      channel: channelId || 'whatsapp',
      account_id: ctx.accountId || null,
      metadata: null,
      created_at: Date.now(),
    });

    const content = ctx.content || ctx.body;
    if (content) {
      queueEmbedding(messageId, content);
    }
  } catch (err) {
    console.error('[wa-archive] Error processing sent message:', err);
  }
}

/**
 * Handle outbound messages via message_sending plugin hook.
 * This fires BEFORE delivery for ALL outbound messages (regular replies + message tool).
 * Primary capture path for outbound messages.
 */
export function handleMessageSending(
  event: { to: string; content: string; metadata?: Record<string, unknown> },
  ctx: { channelId: string; accountId?: string; conversationId?: string; sessionKey?: string }
): void {
  try {
    if (ctx.channelId && !SUPPORTED_CHANNELS.has(ctx.channelId)) return;

    const content = event.content;
    if (!content || content.trim() === 'NO_REPLY' || content.trim() === 'HEARTBEAT_OK') return;

    const messageId = randomUUID();
    const chatId = event.to || ctx.conversationId || '';
    const isGroup = chatId.endsWith('@g.us');
    const chatType = isGroup ? 'group' : 'direct';
    const sessionKey = ctx.sessionKey || (ctx as any).sessionKey || null;

    insertMessage({
      id: messageId,
      session_key: sessionKey,
      chat_id: chatId,
      chat_type: chatType,
      chat_name: (event.metadata?.groupName || event.metadata?.groupSubject || event.metadata?.subject || null) as string | null,
      sender_id: null,
      sender_name: outboundSenderName,
      timestamp: Date.now(),
      content,
      media_local_path: null,
      media_url: null,
      media_type: null,
      reply_to_id: null,
      is_from_me: 1,
      direction: 'outbound',
      channel: ctx.channelId || 'whatsapp',
      account_id: ctx.accountId || null,
      metadata: null,
      created_at: Date.now(),
    });

    queueEmbedding(messageId, content);

    // Attach accumulated LLM usage to this outbound message
    if (sessionKey) {
      attachUsageToMessage(messageId, sessionKey);
    }
  } catch (err) {
    console.error('[wa-archive] Error processing sending message:', err);
  }
}

export function handleMessagePreprocessed(event: any): void {
  try {
    const ctx = event?.context || event;
    const metadata = ctx.metadata || event.metadata || {};
    const channelId = ctx.channelId || ctx.channel || metadata.channel || metadata.provider;
    if (channelId && !SUPPORTED_CHANNELS.has(channelId)) return;

    const messageId = ctx.messageId || ctx.id;
    if (!messageId) return;

    const content = ctx.content || ctx.body;
    if (!content) return;

    updateMessageContent(messageId, content);

    // Re-queue embedding with updated content
    queueEmbedding(messageId, content);
  } catch (err) {
    console.error('[wa-archive] Error processing preprocessed message:', err);
  }
}
