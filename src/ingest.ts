import { randomUUID } from 'crypto';
import { insertMessage, updateMessageContent } from './db';
import { queueEmbedding } from './embeddings';
import { queueMediaDownload } from './media';

export function handleMessageReceived(event: any): void {
  try {
    const ctx = event?.context || event;
    const metadata = ctx.metadata || event.metadata || {};
    const channelId = ctx.channelId || ctx.channel || metadata.channel || metadata.provider;
    // Skip non-whatsapp if channelId is known and not whatsapp
    if (channelId && channelId !== 'whatsapp') return;

    const messageId = ctx.messageId || ctx.id || event.messageId || randomUUID();
    const isGroup = metadata.isGroup || false;
    const chatId = isGroup
      ? metadata.groupId || ctx.conversationId || ctx.from || event.from
      : ctx.conversationId || ctx.from || event.from;
    const chatType = isGroup ? 'group' : 'direct';

    insertMessage({
      id: messageId,
      session_key: ctx.sessionKey || event.sessionKey || null,
      chat_id: chatId,
      chat_type: chatType,
      chat_name: metadata.groupName || metadata.contactName || null,
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
      channel: 'whatsapp',
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

export function handleMessageSent(event: any): void {
  try {
    const ctx = event?.context || event;
    const metadata = ctx.metadata || event.metadata || {};
    const channelId = ctx.channelId || ctx.channel || metadata.channel || metadata.provider;
    if (channelId && channelId !== 'whatsapp') return;
    if (ctx.success === false) return;

    const messageId = ctx.messageId || ctx.id || event.messageId || randomUUID();
    const isGroup = ctx.isGroup || event.isGroup || false;
    const chatId = isGroup
      ? ctx.groupId || ctx.conversationId || ctx.to || event.to
      : ctx.conversationId || ctx.to || event.to;
    const chatType = isGroup ? 'group' : 'direct';

    insertMessage({
      id: messageId,
      session_key: ctx.sessionKey || event.sessionKey || null,
      chat_id: chatId,
      chat_type: chatType,
      chat_name: ctx.groupName || ctx.contactName || null,
      sender_id: null,
      sender_name: 'Nymeria',
      timestamp: ctx.timestamp || event.timestamp || Date.now(),
      content: ctx.content || ctx.body || event.content || null,
      media_local_path: null,
      media_url: null,
      media_type: null,
      reply_to_id: null,
      is_from_me: 1,
      direction: 'outbound',
      channel: 'whatsapp',
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

export function handleMessagePreprocessed(event: any): void {
  try {
    const ctx = event?.context || event;
    const metadata = ctx.metadata || event.metadata || {};
    const channelId = ctx.channelId || ctx.channel || metadata.channel || metadata.provider;
    if (channelId && channelId !== 'whatsapp') return;

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
