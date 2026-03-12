import { getDb } from '../db';

interface StatsParams {
  period?: 'today' | 'week' | 'month' | 'all';
  chat?: string;
  sender?: string;
}

export function buildWaStatsTool(allowFrom: string[]) {
  return {
    name: 'wa_stats',
    description:
      'Get statistics about the WhatsApp message archive. Shows total messages, messages per chat, messages per sender, busiest hours, and inbound/outbound ratio.',
    parameters: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'week', 'month', 'all'],
          description: 'Time period (default: week)',
        },
        chat: {
          type: 'string',
          description: 'Filter by specific chat name or ID',
        },
        sender: {
          type: 'string',
          description: 'Filter by specific sender name or phone',
        },
      },
    },
    allowFrom,
    execute: (params: StatsParams) => {
      try {
        return executeStats(params);
      } catch (err) {
        return { error: `Stats failed: ${(err as Error).message}` };
      }
    },
  };
}

function executeStats(params: StatsParams): object {
  const db = getDb();
  const period = params.period || 'week';
  const sinceTs = getPeriodStart(period);

  const conditions: string[] = [];
  const bindParams: Record<string, any> = {};

  if (sinceTs) {
    conditions.push('timestamp >= @sinceTs');
    bindParams.sinceTs = sinceTs;
  }
  if (params.chat) {
    conditions.push('(chat_name LIKE @chat OR chat_id LIKE @chat)');
    bindParams.chat = `%${params.chat}%`;
  }
  if (params.sender) {
    conditions.push('(sender_name LIKE @sender OR sender_id LIKE @sender)');
    bindParams.sender = `%${params.sender}%`;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Total messages
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM messages ${where}`)
    .get(bindParams) as { total: number };

  // Messages per chat (top 10)
  const perChat = db
    .prepare(
      `SELECT chat_name, chat_id, COUNT(*) AS count
       FROM messages ${where}
       GROUP BY chat_id
       ORDER BY count DESC
       LIMIT 10`
    )
    .all(bindParams) as Array<{ chat_name: string | null; chat_id: string; count: number }>;

  // Messages per sender (top 10)
  const perSender = db
    .prepare(
      `SELECT sender_name, sender_id, COUNT(*) AS count
       FROM messages ${where} ${where ? 'AND' : 'WHERE'} sender_id IS NOT NULL
       GROUP BY sender_id
       ORDER BY count DESC
       LIMIT 10`
    )
    .all(bindParams) as Array<{ sender_name: string | null; sender_id: string; count: number }>;

  // Busiest hours
  const busiestHours = db
    .prepare(
      `SELECT CAST((timestamp / 3600000) % 24 AS INTEGER) AS hour, COUNT(*) AS count
       FROM messages ${where}
       GROUP BY hour
       ORDER BY count DESC
       LIMIT 5`
    )
    .all(bindParams) as Array<{ hour: number; count: number }>;

  // Inbound vs outbound
  const directionStats = db
    .prepare(
      `SELECT direction, COUNT(*) AS count
       FROM messages ${where}
       GROUP BY direction`
    )
    .all(bindParams) as Array<{ direction: string; count: number }>;

  const inbound = directionStats.find((d) => d.direction === 'inbound')?.count || 0;
  const outbound = directionStats.find((d) => d.direction === 'outbound')?.count || 0;

  return {
    period,
    total: totalRow.total,
    top_chats: perChat.map((c) => ({
      name: c.chat_name || c.chat_id,
      count: c.count,
    })),
    top_senders: perSender.map((s) => ({
      name: s.sender_name || s.sender_id,
      count: s.count,
    })),
    busiest_hours: busiestHours.map((h) => ({
      hour: `${String(h.hour).padStart(2, '0')}:00`,
      count: h.count,
    })),
    direction: { inbound, outbound },
  };
}

function getPeriodStart(period: string): number | null {
  const now = Date.now();
  switch (period) {
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'week':
      return now - 7 * 24 * 60 * 60 * 1000;
    case 'month':
      return now - 30 * 24 * 60 * 60 * 1000;
    case 'all':
      return null;
    default:
      return now - 7 * 24 * 60 * 60 * 1000;
  }
}
