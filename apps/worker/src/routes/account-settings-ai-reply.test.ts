import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', () => ({
  getLinkBaseUrl: vi.fn(),
  setLinkBaseUrl: vi.fn(),
  getTrackedLinkBaseUrl: vi.fn(),
  setTrackedLinkBaseUrl: vi.fn(),
}));

import { accountSettings } from './account-settings.js';
import type { Env } from '../index.js';

type Row = { key: string; value: string } | undefined;

function fakeDb(rows: Row[]) {
  const store = new Map(rows.filter(Boolean).map((r) => [r!.key, r!.value]));
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...params: unknown[]) => ({
        first: vi.fn().mockResolvedValue(
          sql.includes('ai_reply_enabled') && store.has('ai_reply_enabled')
            ? { value: store.get('ai_reply_enabled') }
            : sql.includes('ai_reply_daily_limit') && store.has('ai_reply_daily_limit')
              ? { value: store.get('ai_reply_daily_limit') }
              : null,
        ),
        run: vi.fn().mockImplementation(async () => {
          inserts.push({ sql, params });
          if (sql.includes('DELETE')) {
            const key = sql.includes('ai_reply_enabled') ? 'ai_reply_enabled' : 'ai_reply_daily_limit';
            store.delete(key);
          } else if (sql.includes('INSERT INTO account_settings')) {
            const key = params[2] as string;
            const value = params[2 + 1] as string;
            // key はプレースホルダに含まれずリテラル ('ai_reply_enabled' 等) なので
            // ここでは値 (params[2]) だけを見て判定する必要がある — SQL 側の
            // リテラルキーで判定する。
            if (sql.includes("'ai_reply_enabled'")) store.set('ai_reply_enabled', params[2] as string);
            if (sql.includes("'ai_reply_daily_limit'")) store.set('ai_reply_daily_limit', params[2] as string);
          }
          return { success: true };
        }),
      })),
    })),
  };
  return { db: db as unknown as D1Database, inserts, store };
}

function app() {
  const a = new Hono<Env>();
  a.route('/', accountSettings);
  return a;
}

describe('GET/PUT /api/account-settings/ai-reply-enabled', () => {
  test('未設定なら null (上位設定に従う) を返す', async () => {
    const { db } = fakeDb([]);
    const res = await app().request(
      '/api/account-settings/ai-reply-enabled?accountId=acct-1',
      {},
      { DB: db } as unknown as Env['Bindings'],
    );
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toBeNull();
  });

  test('false を設定すると次の GET で false が返る', async () => {
    const { db, store } = fakeDb([]);
    await app().request(
      '/api/account-settings/ai-reply-enabled',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'acct-1', enabled: false }) },
      { DB: db } as unknown as Env['Bindings'],
    );
    expect(store.get('ai_reply_enabled')).toBe('false');
  });

  test('enabled=null を送ると設定を削除する (上位設定に戻す)', async () => {
    const { db, store } = fakeDb([{ key: 'ai_reply_enabled', value: 'false' }]);
    await app().request(
      '/api/account-settings/ai-reply-enabled',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'acct-1', enabled: null }) },
      { DB: db } as unknown as Env['Bindings'],
    );
    expect(store.has('ai_reply_enabled')).toBe(false);
  });
});

describe('PUT /api/account-settings/ai-reply-daily-limit', () => {
  test('負の値は 400 で拒否する', async () => {
    const { db } = fakeDb([]);
    const res = await app().request(
      '/api/account-settings/ai-reply-daily-limit',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'acct-1', limit: -1 }) },
      { DB: db } as unknown as Env['Bindings'],
    );
    expect(res.status).toBe(400);
  });

  test('accountId 無しは 400', async () => {
    const { db } = fakeDb([]);
    const res = await app().request(
      '/api/account-settings/ai-reply-daily-limit',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 10 }) },
      { DB: db } as unknown as Env['Bindings'],
    );
    expect(res.status).toBe(400);
  });
});
