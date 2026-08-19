import { describe, expect, test, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({
  getAccountSetting: vi.fn(),
  setAccountSetting: vi.fn(),
}));

import { getAccountSetting, setAccountSetting } from '@line-crm/db';
import { syncMessagesFts } from './messages-fts-sync.js';

function fakeDb(rows: Array<{ id: string; friend_id: string; content: string; created_at: string }>) {
  const batched: unknown[][] = [];
  const lookupById = new Map(rows.map((r) => [r.id, r]));
  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        params: [] as unknown[],
        bind: vi.fn((...p: unknown[]) => { stmt.params = p; return stmt; }),
        all: vi.fn(async () => {
          const [createdAt, createdAt2, id] = stmt.params as string[];
          const filtered = rows.filter((r) => r.created_at > createdAt || (r.created_at === createdAt2 && r.id > id));
          return { results: filtered.sort((a, b) => (a.created_at + a.id).localeCompare(b.created_at + b.id)) };
        }),
        first: vi.fn(async () => {
          const id = stmt.params[0] as string;
          return lookupById.get(id) ?? null;
        }),
      };
      return stmt;
    }),
    batch: vi.fn(async (stmts: Array<{ params: unknown[] }>) => {
      batched.push(...stmts.map((s) => s.params));
      return [];
    }),
  };
  return { db: db as unknown as D1Database, batched };
}

describe('syncMessagesFts', () => {
  test('カーソル未設定なら最初から全件同期する', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue(null);
    const { db, batched } = fakeDb([
      { id: 'm1', friend_id: 'f1', content: 'こんにちは', created_at: '2026-08-19T10:00:00.000+09:00' },
      { id: 'm2', friend_id: 'f1', content: 'ありがとう', created_at: '2026-08-19T10:01:00.000+09:00' },
    ]);

    const count = await syncMessagesFts(db);

    expect(count).toBe(2);
    expect(batched).toHaveLength(2);
    expect(vi.mocked(setAccountSetting)).toHaveBeenCalledWith(
      db,
      '__global__',
      'messages_fts_cursor',
      JSON.stringify({ createdAt: '2026-08-19T10:01:00.000+09:00', id: 'm2' }),
    );
  });

  test('同一ミリ秒の複数行でも取りこぼさない (複合カーソル)', async () => {
    // created_at が同じ行が複数あるケース (キュー配信のバッチ処理等で起こり得る)。
    vi.mocked(getAccountSetting).mockResolvedValue(
      JSON.stringify({ createdAt: '2026-08-19T10:00:00.000+09:00', id: 'm1' }),
    );
    const { db, batched } = fakeDb([
      { id: 'm1', friend_id: 'f1', content: 'A', created_at: '2026-08-19T10:00:00.000+09:00' },
      { id: 'm2', friend_id: 'f1', content: 'B', created_at: '2026-08-19T10:00:00.000+09:00' },
      { id: 'm3', friend_id: 'f1', content: 'C', created_at: '2026-08-19T10:00:00.000+09:00' },
    ]);

    const count = await syncMessagesFts(db);

    // m1 は前回処理済みなのでスキップ、m2・m3 のみ同期される
    expect(count).toBe(2);
    expect(batched.map((p) => p[0])).toEqual(['m2', 'm3']);
  });

  test('未索引行が無ければ 0 を返し、カーソルを更新しない', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue(null);
    vi.mocked(setAccountSetting).mockClear();
    const { db } = fakeDb([]);

    const count = await syncMessagesFts(db);

    expect(count).toBe(0);
    expect(setAccountSetting).not.toHaveBeenCalled();
  });

  test('カーソルが壊れたJSONでも例外を投げず最初から同期する', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue('not-json{{{');
    const { db, batched } = fakeDb([
      { id: 'm1', friend_id: 'f1', content: 'X', created_at: '2026-08-19T10:00:00.000+09:00' },
    ]);

    const count = await syncMessagesFts(db);

    expect(count).toBe(1);
    expect(batched).toHaveLength(1);
  });
});
