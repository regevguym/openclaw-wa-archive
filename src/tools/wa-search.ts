import { getDb, isVecEnabled } from '../db';
import { generateEmbedding } from '../embeddings';

interface SearchParams {
  query: string;
  sender?: string;
  chat?: string;
  chat_type?: string;
  from_date?: string;
  to_date?: string;
  mode?: 'fts' | 'semantic' | 'hybrid';
  limit?: number;
}

interface SearchResult {
  message_id: string;
  sender_name: string | null;
  chat_name: string | null;
  timestamp: number;
  content: string | null;
  direction: string;
  chat_type: string;
  score?: number;
}

export function buildWaSearchTool(allowFrom: string[]) {
  return {
    name: 'wa_search',
    description:
      'Search the WhatsApp message archive. Supports full-text search, semantic/vector search, or hybrid mode. Can filter by sender, chat, chat type, and date range.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (natural language or keywords)',
        },
        sender: {
          type: 'string',
          description: 'Filter by sender name or phone number',
        },
        chat: {
          type: 'string',
          description: 'Filter by chat/group name or ID',
        },
        chat_type: {
          type: 'string',
          enum: ['group', 'direct'],
          description: 'Filter by chat type',
        },
        from_date: {
          type: 'string',
          description: 'Start date (ISO 8601 or relative like "2 days ago", "yesterday", "last week")',
        },
        to_date: {
          type: 'string',
          description: 'End date (ISO 8601 or relative)',
        },
        mode: {
          type: 'string',
          enum: ['fts', 'semantic', 'hybrid'],
          description: 'Search mode: fts (full-text), semantic (vector), hybrid (both, default)',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20)',
        },
      },
      required: ['query'],
    },
    allowFrom,
    execute: async (_callId: string, params: SearchParams) => {
      try {
        return await executeSearch(params);
      } catch (err) {
        return { error: `Search failed: ${(err as Error).message}` };
      }
    },
  };
}

async function executeSearch(params: SearchParams): Promise<object> {
  const db = getDb();
  const mode = params.mode || 'hybrid';
  const limit = Math.min(params.limit || 20, 100);

  const fromTs = params.from_date ? parseDate(params.from_date) : null;
  const toTs = params.to_date ? parseDate(params.to_date) : null;

  let ftsResults: SearchResult[] = [];
  let semanticResults: SearchResult[] = [];

  // FTS search
  if (mode === 'fts' || mode === 'hybrid') {
    ftsResults = searchFts(db, params.query, {
      sender: params.sender,
      chat: params.chat,
      chatType: params.chat_type,
      fromTs,
      toTs,
      limit,
    });
  }

  // Semantic search
  if ((mode === 'semantic' || mode === 'hybrid') && isVecEnabled()) {
    semanticResults = await searchSemantic(db, params.query, {
      sender: params.sender,
      chat: params.chat,
      chatType: params.chat_type,
      fromTs,
      toTs,
      limit,
    });
  }

  // If hybrid, merge and deduplicate
  if (mode === 'hybrid' && ftsResults.length > 0 && semanticResults.length > 0) {
    return { results: mergeResults(ftsResults, semanticResults, limit) };
  }

  const results = ftsResults.length > 0 ? ftsResults : semanticResults;
  return { results, total: results.length, mode: isVecEnabled() ? mode : 'fts' };
}

interface FilterOpts {
  sender?: string;
  chat?: string;
  chatType?: string;
  fromTs?: number | null;
  toTs?: number | null;
  limit: number;
}

function buildWhereClause(opts: FilterOpts): { where: string; params: Record<string, any> } {
  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (opts.sender) {
    conditions.push('(m.sender_name LIKE @sender OR m.sender_id LIKE @sender)');
    params.sender = `%${opts.sender}%`;
  }
  if (opts.chat) {
    conditions.push('(m.chat_name LIKE @chat OR m.chat_id LIKE @chat)');
    params.chat = `%${opts.chat}%`;
  }
  if (opts.chatType) {
    conditions.push('m.chat_type = @chatType');
    params.chatType = opts.chatType;
  }
  if (opts.fromTs) {
    conditions.push('m.timestamp >= @fromTs');
    params.fromTs = opts.fromTs;
  }
  if (opts.toTs) {
    conditions.push('m.timestamp <= @toTs');
    params.toTs = opts.toTs;
  }

  const where = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
  return { where, params };
}

function searchFts(
  db: any,
  query: string,
  opts: FilterOpts
): SearchResult[] {
  const { where, params } = buildWhereClause(opts);

  // Escape FTS special characters for safety
  const ftsQuery = query.replace(/['"]/g, '');

  const sql = `
    SELECT
      m.id AS message_id,
      m.sender_name,
      m.chat_name,
      m.timestamp,
      m.content,
      m.direction,
      m.chat_type,
      rank
    FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    WHERE messages_fts MATCH @ftsQuery
    ${where}
    ORDER BY rank
    LIMIT @limit
  `;

  return db.prepare(sql).all({ ...params, ftsQuery, limit: opts.limit }) as SearchResult[];
}

async function searchSemantic(
  db: any,
  query: string,
  opts: FilterOpts
): Promise<SearchResult[]> {
  const embedding = await generateEmbedding(query);
  if (!embedding) return [];

  const { where, params } = buildWhereClause(opts);
  const buffer = Buffer.from(new Float32Array(embedding).buffer);

  const sql = `
    SELECT
      m.id AS message_id,
      m.sender_name,
      m.chat_name,
      m.timestamp,
      m.content,
      m.direction,
      m.chat_type,
      v.distance AS score
    FROM messages_vec v
    JOIN messages m ON m.rowid = v.message_rowid
    WHERE v.embedding MATCH @embedding AND k = @limit
    ${where}
    ORDER BY v.distance
  `;

  return db.prepare(sql).all({ ...params, embedding: buffer, limit: opts.limit }) as SearchResult[];
}

function mergeResults(
  fts: SearchResult[],
  semantic: SearchResult[],
  limit: number
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  // Interleave results, prioritizing FTS matches that also appear in semantic
  const semanticIds = new Set(semantic.map((r) => r.message_id));

  // First: results that appear in both
  for (const r of fts) {
    if (semanticIds.has(r.message_id) && !seen.has(r.message_id)) {
      seen.add(r.message_id);
      merged.push(r);
    }
  }

  // Then: remaining FTS results
  for (const r of fts) {
    if (!seen.has(r.message_id)) {
      seen.add(r.message_id);
      merged.push(r);
    }
  }

  // Then: remaining semantic results
  for (const r of semantic) {
    if (!seen.has(r.message_id)) {
      seen.add(r.message_id);
      merged.push(r);
    }
  }

  return merged.slice(0, limit);
}

function parseDate(input: string): number | null {
  // Try relative dates first
  const now = Date.now();
  const lower = input.toLowerCase().trim();

  if (lower === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (lower === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (lower === 'last week') {
    return now - 7 * 24 * 60 * 60 * 1000;
  }
  if (lower === 'last month') {
    return now - 30 * 24 * 60 * 60 * 1000;
  }

  // "N days/hours/minutes ago"
  const agoMatch = lower.match(/^(\d+)\s+(day|hour|minute|week|month)s?\s+ago$/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2];
    const ms: Record<string, number> = {
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };
    return now - n * (ms[unit] || 0);
  }

  // Try ISO 8601
  const ts = new Date(input).getTime();
  return isNaN(ts) ? null : ts;
}
