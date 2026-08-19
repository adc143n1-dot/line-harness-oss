import { Hono } from 'hono';
import type { Env } from '../index.js';

const messages = new Hono<Env>();

const MIN_QUERY_LENGTH = 3;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

interface SearchRow {
  id: string;
  friend_id: string;
  direction: string;
  message_type: string;
  content: string;
  created_at: string;
  display_name: string | null;
  picture_url: string | null;
}

/**
 * FTS5 MATCH のクエリ言語 (AND/OR/NOT/"..."/カラムフィルタ等) をユーザー入力の
 * 自由文に適用すると、記号を含む入力で構文エラーになる。常にフレーズとして
 * 二重引用符で囲み、埋め込まれた " は "" にエスケープして無害化する。
 */
function toFtsPhraseQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

// メッセージ本文の全文検索 (messages_fts, migration 074)。
// friendId を指定すればチャット詳細内検索、省略すれば全チャット横断検索になる。
//
// trigram トークナイザの制約で、3文字未満のクエリは常に0件になる
// (インデックス自体に2文字以下のトークンが存在しないため)。無言で0件を
// 返すとユーザーが「検索が壊れている」と誤解するので、400 で明示的に断る。
messages.get('/api/messages/search', async (c) => {
  try {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < MIN_QUERY_LENGTH) {
      return c.json(
        { success: false, error: `検索キーワードは${MIN_QUERY_LENGTH}文字以上で入力してください` },
        400,
      );
    }

    const friendId = c.req.query('friendId') || undefined;
    const limitParam = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

    const conditions = ['messages_fts MATCH ?'];
    const params: unknown[] = [toFtsPhraseQuery(q)];
    if (friendId) {
      conditions.push('fts.friend_id = ?');
      params.push(friendId);
    }
    params.push(limit);

    const result = await c.env.DB
      .prepare(
        `SELECT m.id, m.friend_id, m.direction, m.message_type, m.content, m.created_at,
                f.display_name, f.picture_url
           FROM messages_fts fts
           JOIN messages_log m ON m.id = fts.id
           JOIN friends f ON f.id = m.friend_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY m.created_at DESC
          LIMIT ?`,
      )
      .bind(...params)
      .all<SearchRow>();

    return c.json({
      success: true,
      data: result.results.map((row) => ({
        id: row.id,
        friendId: row.friend_id,
        friendName: row.display_name || '名前なし',
        friendPictureUrl: row.picture_url,
        direction: row.direction,
        messageType: row.message_type,
        content: row.content,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/messages/search error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { messages };
