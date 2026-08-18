import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', () => ({ jstNow: vi.fn(() => '2026-08-19T21:00:00.000+09:00') }));

import { emergency } from './emergency.js';
import type { Env } from '../index.js';
import type { AuthenticatedStaff } from '../middleware/auth.js';

function fakeDb(changes: number) {
  const queries: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ run: vi.fn(async () => { queries.push(sql); return { meta: { changes } }; }) })),
      run: vi.fn(async () => { queries.push(sql); return { meta: { changes } }; }),
    })),
  };
  return { db: db as unknown as D1Database, queries };
}

function app(staff?: AuthenticatedStaff) {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => {
    if (staff) c.set('staff', staff);
    await next();
  });
  a.route('/', emergency);
  return a;
}

async function post(path: string, staff: AuthenticatedStaff | undefined, db: D1Database) {
  return app(staff).request(path, { method: 'POST' }, { DB: db } as unknown as Env['Bindings']);
}

describe('POST /api/emergency/stop-broadcasts — 権限制限', () => {
  test('staff 権限は 403 で拒否する (全配信停止は影響が大きいため)', async () => {
    const { db } = fakeDb(0);
    const res = await post('/api/emergency/stop-broadcasts', { id: 's1', name: 'A', role: 'staff' }, db);
    expect(res.status).toBe(403);
  });

  test('未認証は 403 で拒否する', async () => {
    const { db } = fakeDb(0);
    const res = await post('/api/emergency/stop-broadcasts', undefined, db);
    expect(res.status).toBe(403);
  });

  test('admin は実行でき、対象件数を返す', async () => {
    const { db, queries } = fakeDb(3);
    const res = await post('/api/emergency/stop-broadcasts', { id: 's1', name: 'A', role: 'admin' }, db);
    const body = (await res.json()) as { data: { stopped: number } };

    expect(res.status).toBe(200);
    expect(body.data.stopped).toBe(3);
    expect(queries[0]).toContain("status = 'scheduled'");
    expect(queries[0]).toContain("status = 'draft'");
  });

  test('owner も実行できる', async () => {
    const { db } = fakeDb(0);
    const res = await post('/api/emergency/stop-broadcasts', { id: 's1', name: 'A', role: 'owner' }, db);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/emergency/stop-scenarios — 権限制限', () => {
  test('staff 権限は 403 で拒否する', async () => {
    const { db } = fakeDb(0);
    const res = await post('/api/emergency/stop-scenarios', { id: 's1', name: 'A', role: 'staff' }, db);
    expect(res.status).toBe(403);
  });

  test('admin は実行でき、is_active=1 の行だけを対象にする', async () => {
    const { db, queries } = fakeDb(5);
    const res = await post('/api/emergency/stop-scenarios', { id: 's1', name: 'A', role: 'admin' }, db);
    const body = (await res.json()) as { data: { stopped: number } };

    expect(res.status).toBe(200);
    expect(body.data.stopped).toBe(5);
    expect(queries[0]).toContain('is_active = 0');
    expect(queries[0]).toContain('WHERE is_active = 1');
  });
});
