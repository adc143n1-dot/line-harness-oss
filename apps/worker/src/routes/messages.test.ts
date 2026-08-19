import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { messages } from './messages.js';
import type { Env } from '../index.js';

interface Row {
  id: string; friend_id: string; direction: string; message_type: string;
  content: string; created_at: string; display_name: string | null; picture_url: string | null;
}

function fakeDb(rows: Row[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        params: [] as unknown[],
        bind: vi.fn((...p: unknown[]) => { stmt.params = p; return stmt; }),
        all: vi.fn(async () => {
          queries.push({ sql, params: stmt.params });
          return { results: rows };
        }),
      };
      return stmt;
    }),
  };
  return { db: db as unknown as D1Database, queries };
}

function app() {
  const a = new Hono<Env>();
  a.route('/', messages);
  return a;
}

async function search(qs: string, db: D1Database) {
  return app().request(`/api/messages/search${qs}`, {}, { DB: db } as unknown as Env['Bindings']);
}

describe('GET /api/messages/search', () => {
  test('3文字未満は 400 で明示的に断る (trigram の制約)', async () => {
    const { db, queries } = fakeDb([]);
    const res = await search('?q=火曜', db);

    expect(res.status).toBe(400);
    expect(queries).toHaveLength(0); // DB を叩く前に弾く
  });

  test('3文字以上は検索を実行し、結果を整形して返す', async () => {
    const { db, queries } = fakeDb([
      {
        id: 'm1', friend_id: 'f1', direction: 'incoming', message_type: 'text',
        content: '予約の変更をお願いします', created_at: '2026-08-19T10:00:00.000+09:00',
        display_name: 'テスト太郎', picture_url: null,
      },
    ]);
    const res = await search('?q=予約の', db);
    const body = (await res.json()) as { success: boolean; data: Array<{ friendName: string }> };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].friendName).toBe('テスト太郎');
    // 記号を含む入力でも FTS5 の構文エラーにならないよう、フレーズとして二重引用符で囲む
    expect(queries[0].params[0]).toBe('"予約の"');
  });

  test('ダブルクォートを含む入力もエスケープしてフレーズ化する', async () => {
    const { db, queries } = fakeDb([]);
    await search(`?q=${encodeURIComponent('"注文"確認')}`, db);

    expect(queries[0].params[0]).toBe('"""注文""確認"');
  });

  test('friendId 指定時は絞り込み条件を追加する', async () => {
    const { db, queries } = fakeDb([]);
    await search('?q=予約の&friendId=f1', db);

    expect(queries[0].sql).toContain('fts.friend_id = ?');
    expect(queries[0].params).toContain('f1');
  });

  test('friendId 省略時は絞り込みを追加しない (全チャット横断検索)', async () => {
    const { db, queries } = fakeDb([]);
    await search('?q=予約の', db);

    expect(queries[0].sql).not.toContain('fts.friend_id');
  });

  test('limit は上限 (100) でクランプする', async () => {
    const { db, queries } = fakeDb([]);
    await search('?q=予約の&limit=99999', db);

    expect(queries[0].params[queries[0].params.length - 1]).toBe(100);
  });
});
