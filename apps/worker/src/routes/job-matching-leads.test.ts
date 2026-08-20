import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { jobMatchingLeads } from './job-matching-leads.js';
import type { Env } from '../index.js';
import type { AuthenticatedStaff } from '../middleware/auth.js';

const ROW = {
  id: 'friend-1',
  display_name: 'テスト太郎',
  picture_url: null,
  q1_answer: 'fulltime',
  q2_answer: 'high_value',
  lead_score: 70,
  lead_temperature: 'hot',
  job_matching_conversation_state: 'diagnosed',
  created_at: '2026-08-19T00:00:00.000+09:00',
  updated_at: '2026-08-20T00:00:00.000+09:00',
};

function fakeDb(opts: { total: number; rows: typeof ROW[] }) {
  const queries: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        queries.push({ sql, args });
        return {
          first: vi.fn(async () => ({ count: opts.total })),
          all: vi.fn(async () => ({ results: opts.rows })),
        };
      }),
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
  a.route('/', jobMatchingLeads);
  return a;
}

async function get(path: string, staff: AuthenticatedStaff | undefined, db: D1Database) {
  return app(staff).request(path, {}, { DB: db } as unknown as Env['Bindings']);
}

describe('GET /api/job-matching/leads — 権限', () => {
  test('未認証は 403', async () => {
    const { db } = fakeDb({ total: 0, rows: [] });
    const res = await get('/api/job-matching/leads', undefined, db);
    expect(res.status).toBe(403);
  });

  test('staff 権限でも閲覧できる', async () => {
    const { db } = fakeDb({ total: 1, rows: [ROW] });
    const res = await get('/api/job-matching/leads', { id: 's1', name: 'A', role: 'staff' }, db);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/job-matching/leads — 一覧・整形', () => {
  test('camelCase に整形して返す', async () => {
    const { db } = fakeDb({ total: 1, rows: [ROW] });
    const res = await get('/api/job-matching/leads', { id: 's1', name: 'A', role: 'owner' }, db);
    const body = (await res.json()) as {
      success: boolean;
      data: { items: Array<Record<string, unknown>>; total: number; hasNextPage: boolean };
    };

    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]).toMatchObject({
      id: 'friend-1',
      displayName: 'テスト太郎',
      q1Answer: 'fulltime',
      q2Answer: 'high_value',
      leadScore: 70,
      leadTemperature: 'hot',
      conversationState: 'diagnosed',
    });
    expect(body.data.hasNextPage).toBe(false);
  });

  test('job_matching_conversation_state IS NOT NULL を必ず条件に含める (未開始の友だちを除外)', async () => {
    const { db, queries } = fakeDb({ total: 0, rows: [] });
    await get('/api/job-matching/leads', { id: 's1', name: 'A', role: 'owner' }, db);

    const listQuery = queries.find((q) => q.sql.includes('SELECT f.id'));
    expect(listQuery?.sql).toContain('job_matching_conversation_state IS NOT NULL');
  });

  test('temperature フィルタが条件・バインド値に反映される', async () => {
    const { db, queries } = fakeDb({ total: 0, rows: [] });
    await get('/api/job-matching/leads?temperature=hot', { id: 's1', name: 'A', role: 'owner' }, db);

    const listQuery = queries.find((q) => q.sql.includes('SELECT f.id'));
    expect(listQuery?.sql).toContain('f.lead_temperature = ?');
    expect(listQuery?.args).toContain('hot');
  });

  test('不正な temperature 値は無視される (SQLインジェクション対策も兼ねる)', async () => {
    const { db, queries } = fakeDb({ total: 0, rows: [] });
    await get("/api/job-matching/leads?temperature=hot'--", { id: 's1', name: 'A', role: 'owner' }, db);

    const listQuery = queries.find((q) => q.sql.includes('SELECT f.id'));
    expect(listQuery?.sql).not.toContain('f.lead_temperature = ?');
  });

  test('search が display_name の LIKE 条件になる', async () => {
    const { db, queries } = fakeDb({ total: 0, rows: [] });
    await get('/api/job-matching/leads?search=太郎', { id: 's1', name: 'A', role: 'owner' }, db);

    const listQuery = queries.find((q) => q.sql.includes('SELECT f.id'));
    expect(listQuery?.sql).toContain('f.display_name LIKE ?');
    expect(listQuery?.args).toContain('%太郎%');
  });
});
