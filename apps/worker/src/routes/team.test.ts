import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

vi.mock('@line-crm/db', () => ({
  jstNow: vi.fn(() => '2026-08-22T15:00:00.000+09:00'),
}));

const inboxMocks = vi.hoisted(() => ({
  getAllUnansweredRows: vi.fn(),
}));
vi.mock('../services/unanswered-inbox.js', () => inboxMocks);

import { team } from './team.js';

function fakeDb(data: {
  openCounts: Array<{ operator_id: string; status: string; cnt: number }>;
  resolvedToday: Array<{ operator_id: string; cnt: number }>;
  avgFirstResponse: Array<{ operator_id: string; avg_minutes: number | null }>;
  hotUnassigned: number;
}) {
  const boundParams: Record<string, unknown[]> = {};
  const db = {
    prepare(sql: string) {
      const st = {
        params: [] as unknown[],
        bind(...p: unknown[]) { st.params = p; return st; },
        async all() {
          if (sql.includes("status != 'resolved'")) return { results: data.openCounts };
          if (sql.includes('resolved_at >= ?')) {
            boundParams.resolvedToday = st.params;
            return { results: data.resolvedToday };
          }
          if (sql.includes('avg_minutes')) return { results: data.avgFirstResponse };
          return { results: [] };
        },
        async first() {
          if (sql.includes("lead_temperature = 'hot'")) return { cnt: data.hotUnassigned };
          return null;
        },
      };
      return st;
    },
  };
  return { db: db as unknown as D1Database, boundParams };
}

function get(db: D1Database) {
  const app = new Hono<Env>();
  app.route('/', team);
  return app.request('/api/team/overview', {}, { DB: db } as unknown as Env['Bindings']);
}

beforeEach(() => {
  vi.clearAllMocks();
  inboxMocks.getAllUnansweredRows.mockResolvedValue([]);
});

describe('GET /api/team/overview', () => {
  test('スタッフ別の状態内訳・本日解決・平均初動を1行にまとめる', async () => {
    const { db } = fakeDb({
      openCounts: [
        { operator_id: 'staff-a', status: 'unread', cnt: 2 },
        { operator_id: 'staff-a', status: 'in_progress', cnt: 5 },
        { operator_id: 'staff-b', status: 'waiting_reply', cnt: 3 },
      ],
      resolvedToday: [{ operator_id: 'staff-a', cnt: 7 }],
      avgFirstResponse: [{ operator_id: 'staff-a', avg_minutes: 12.34 }],
      hotUnassigned: 0,
    });

    const res = await get(db);
    const body = (await res.json()) as { data: { staff: Array<Record<string, unknown>> } };

    expect(res.status).toBe(200);
    const staffA = body.data.staff.find((s) => s.operatorId === 'staff-a');
    expect(staffA).toMatchObject({
      unread: 2, inProgress: 5, waitingReply: 0, resolvedToday: 7, avgFirstResponseMinutes: 12.3,
    });
    const staffB = body.data.staff.find((s) => s.operatorId === 'staff-b');
    expect(staffB).toMatchObject({
      unread: 0, inProgress: 0, waitingReply: 3, resolvedToday: 0, avgFirstResponseMinutes: null,
    });
  });

  test('本日解決の集計は JST 今日0時を境界にする', async () => {
    const { db, boundParams } = fakeDb({
      openCounts: [], resolvedToday: [], avgFirstResponse: [], hotUnassigned: 0,
    });
    await get(db);
    expect(boundParams.resolvedToday[0]).toBe('2026-08-22T00:00:00.000+09:00');
  });

  test('未割当バックログは未対応行のうち operatorId=null の件数', async () => {
    inboxMocks.getAllUnansweredRows.mockResolvedValue([
      { friendId: 'f1', operatorId: null },
      { friendId: 'f2', operatorId: 'staff-a' },
      { friendId: 'f3', operatorId: null },
    ]);
    const { db } = fakeDb({
      openCounts: [], resolvedToday: [], avgFirstResponse: [], hotUnassigned: 4,
    });

    const res = await get(db);
    const body = (await res.json()) as { data: { global: Record<string, number> } };

    expect(body.data.global).toEqual({
      totalUnanswered: 3,
      unassignedBacklog: 2,
      hotUnassigned: 4,
    });
  });
});
