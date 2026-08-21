import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ENV_OWNER_STAFF_ID, type AuthenticatedStaff } from '../middleware/auth.js';
import type { Env } from '../index.js';

// チーム運用 Phase 2 (プルキュー / release / assign / PUT穴封鎖) のテスト。
// DB はモック: chatRows は friend_id → chat行、candidates は claim-next の
// 候補クエリが返す friend_id 一覧。updateChat は expectedVersion と実際の
// version の一致で成否を返す (D1 の条件付き UPDATE の意味論を再現)。

const chatRows = new Map<string, Record<string, unknown>>();
const claimNextCandidates: string[] = [];

vi.mock('@line-crm/db', () => ({
  getChats: vi.fn(),
  getChatById: vi.fn(async (_db: unknown, id: string) => {
    for (const row of chatRows.values()) if (row.id === id) return row;
    return null;
  }),
  createChat: vi.fn(),
  getFriendById: vi.fn(async (_db: unknown, id: string) =>
    chatRows.has(id) ? { id, line_user_id: `U-${id}`, line_account_id: null } : null,
  ),
  getLineAccountById: vi.fn(),
  getStaffById: vi.fn(async (_db: unknown, id: string) =>
    id === 'staff-target'
      ? { id, name: 'Target', email: null, role: 'staff', api_key: 'k', is_active: 1, created_at: '', updated_at: '' }
      : id === 'staff-inactive'
        ? { id, name: 'Inactive', email: null, role: 'staff', api_key: 'k', is_active: 0, created_at: '', updated_at: '' }
        : null,
  ),
  updateChat: vi.fn(
    async (
      _db: unknown,
      chatId: string,
      updates: Record<string, unknown>,
      opts?: { expectedVersion?: number },
    ) => {
      const row = [...chatRows.values()].find((r) => r.id === chatId);
      if (!row) return false;
      if (opts?.expectedVersion !== undefined && row.version !== opts.expectedVersion) return false;
      if ('operatorId' in updates) row.operator_id = updates.operatorId;
      if ('status' in updates) row.status = updates.status;
      if ('snoozeUntil' in updates) row.snooze_until = updates.snoozeUntil;
      row.version = (row.version as number) + 1;
      return true;
    },
  ),
  jstNow: vi.fn(() => '2026-08-22T12:00:00.000+09:00'),
  toJstString: vi.fn(() => '2026-08-23T12:00:00.000+09:00'),
}));

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
  logOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

import { chats } from './chats.js';
import { updateChat } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';

function makeChatRow(friendId: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `chat-${friendId}`,
    friend_id: friendId,
    operator_id: null,
    status: 'unread',
    notes: null,
    last_message_at: null,
    assigned_at: null,
    first_response_at: null,
    resolved_at: null,
    last_activity_at: null,
    last_replied_by: null,
    version: 0,
    created_at: '2026-08-22T10:00:00.000+09:00',
    updated_at: '2026-08-22T10:00:00.000+09:00',
    ...over,
  };
}

function fakeDb() {
  const db = {
    prepare(sql: string) {
      const st = {
        params: [] as unknown[],
        bind(...p: unknown[]) { st.params = p; return st; },
        async run() { return { meta: { changes: 1 } }; },
        async first() {
          // resolveOrCreateChat の「friend_id で最新 chats 行」lookup
          const m = /FROM chats WHERE friend_id = \?/.exec(sql);
          if (m) return chatRows.get(st.params[0] as string) ?? null;
          return null;
        },
        async all() {
          if (sql.includes('LIMIT 5')) {
            // claim-next の候補クエリ
            return { results: claimNextCandidates.map((friend_id) => ({ friend_id })) };
          }
          return { results: [] };
        },
      };
      return st;
    },
  };
  return db as unknown as D1Database;
}

function app(staff?: AuthenticatedStaff) {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => {
    if (staff) c.set('staff', staff);
    await next();
  });
  a.route('/', chats);
  return a;
}

function post(path: string, staff: AuthenticatedStaff | undefined, body?: unknown) {
  return app(staff).request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB: fakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'token' } as unknown as Env['Bindings'],
  );
}

const STAFF_A: AuthenticatedStaff = { id: 'staff-a', name: 'A', role: 'staff' };
const STAFF_B: AuthenticatedStaff = { id: 'staff-b', name: 'B', role: 'staff' };
const ADMIN: AuthenticatedStaff = { id: 'staff-admin', name: 'Adm', role: 'admin' };

beforeEach(() => {
  vi.clearAllMocks();
  chatRows.clear();
  claimNextCandidates.length = 0;
});

describe('POST /api/chats/claim-next — プル型キュー', () => {
  test('先頭候補を原子的に自分の担当にし、未読は対応中へ進める', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    claimNextCandidates.push('friend-1');

    const res = await post('/api/chats/claim-next', STAFF_A);
    const body = (await res.json()) as { success: boolean; data: { friendId: string; operatorId: string } };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ friendId: 'friend-1', operatorId: 'staff-a' });
    expect(chatRows.get('friend-1')!.operator_id).toBe('staff-a');
    expect(chatRows.get('friend-1')!.status).toBe('in_progress');
  });

  test('先頭候補が直前に取られていたら (version競合) 次候補へフォールバックする', async () => {
    // friend-1 は候補クエリ後に staff-b が取った想定 → operator_id 済み
    chatRows.set('friend-1', makeChatRow('friend-1', { operator_id: 'staff-b', version: 1 }));
    chatRows.set('friend-2', makeChatRow('friend-2'));
    claimNextCandidates.push('friend-1', 'friend-2');

    const res = await post('/api/chats/claim-next', STAFF_A);
    const body = (await res.json()) as { data: { friendId: string } };

    expect(body.data.friendId).toBe('friend-2');
    // friend-1 は触られていない
    expect(chatRows.get('friend-1')!.operator_id).toBe('staff-b');
  });

  test('キューが空なら data:null (エラーにしない)', async () => {
    const res = await post('/api/chats/claim-next', STAFF_A);
    const body = (await res.json()) as { success: boolean; data: null };
    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
  });

  test('共有APIキー認証 (staff_members に実在しない) は 400', async () => {
    const res = await post('/api/chats/claim-next', { id: ENV_OWNER_STAFF_ID, name: 'Owner', role: 'owner' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/chats/:id/release — 担当解除', () => {
  test('自分の担当は外せて、対応中は未読に戻る', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1', { operator_id: 'staff-a', status: 'in_progress', version: 2 }));

    const res = await post('/api/chats/friend-1/release', STAFF_A);

    expect(res.status).toBe(200);
    expect(chatRows.get('friend-1')!.operator_id).toBeNull();
    expect(chatRows.get('friend-1')!.status).toBe('unread');
  });

  test('他のスタッフの担当は staff ロールでは外せない (403)', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1', { operator_id: 'staff-a', status: 'in_progress' }));

    const res = await post('/api/chats/friend-1/release', STAFF_B);

    expect(res.status).toBe(403);
    expect(chatRows.get('friend-1')!.operator_id).toBe('staff-a');
  });

  test('admin は他のスタッフの担当も外せる', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1', { operator_id: 'staff-a', status: 'in_progress' }));

    const res = await post('/api/chats/friend-1/release', ADMIN);

    expect(res.status).toBe(200);
    expect(chatRows.get('friend-1')!.operator_id).toBeNull();
  });

  test('未割当のチャットには 400', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    const res = await post('/api/chats/friend-1/release', STAFF_A);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/chats/:id/assign — 再割当 (admin/owner のみ)', () => {
  test('staff ロールは 403', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    const res = await post('/api/chats/friend-1/assign', STAFF_A, { staffId: 'staff-target' });
    expect(res.status).toBe(403);
  });

  test('admin は任意のスタッフへ割り当てられ、chat_assigned イベントが発火する', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));

    const res = await post('/api/chats/friend-1/assign', ADMIN, { staffId: 'staff-target' });

    expect(res.status).toBe(200);
    expect(chatRows.get('friend-1')!.operator_id).toBe('staff-target');
    expect(vi.mocked(fireEvent)).toHaveBeenCalledWith(
      expect.anything(),
      'chat_assigned',
      expect.objectContaining({
        friendId: 'friend-1',
        eventData: expect.objectContaining({ operatorId: 'staff-target' }),
      }),
      'token',
      null,
    );
  });

  test('無効化されたスタッフへは割り当てられない (404)', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    const res = await post('/api/chats/friend-1/assign', ADMIN, { staffId: 'staff-inactive' });
    expect(res.status).toBe(404);
  });

  test('staffId 無しは 400', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    const res = await post('/api/chats/friend-1/assign', ADMIN, {});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/chats/:id/snooze — 再連絡予約', () => {
  test('未来時刻を設定すると snooze_until と waiting_reply が書き込まれる', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1', { operator_id: 'staff-a', status: 'in_progress' }));
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await post('/api/chats/friend-1/snooze', STAFF_A, { until });

    expect(res.status).toBe(200);
    expect(chatRows.get('friend-1')!.snooze_until).toBe(until);
    expect(chatRows.get('friend-1')!.status).toBe('waiting_reply');
    // 担当は維持される
    expect(chatRows.get('friend-1')!.operator_id).toBe('staff-a');
  });

  test('過去の時刻は 400', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    const res = await post('/api/chats/friend-1/snooze', STAFF_A, { until: '2020-01-01T00:00:00.000+09:00' });
    expect(res.status).toBe(400);
  });

  test('日時として不正な文字列は 400', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    const res = await post('/api/chats/friend-1/snooze', STAFF_A, { until: 'あした' });
    expect(res.status).toBe(400);
  });

  test('until: null でスヌーズ解除できる', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1', { snooze_until: '2026-08-23T09:00:00.000+09:00', status: 'waiting_reply' }));

    const res = await post('/api/chats/friend-1/snooze', STAFF_A, { until: null });

    expect(res.status).toBe(200);
    expect(chatRows.get('friend-1')!.snooze_until).toBeNull();
  });
});

describe('PUT /api/chats/:id — operatorId 受付の穴封鎖 (回帰)', () => {
  test('operatorId を含む PUT は 400 で拒否し、updateChat を呼ばない', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));
    vi.mocked(updateChat).mockClear();

    const res = await app(STAFF_A).request(
      '/api/chats/friend-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorId: 'staff-b' }),
      },
      { DB: fakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'token' } as unknown as Env['Bindings'],
    );

    expect(res.status).toBe(400);
    expect(vi.mocked(updateChat)).not.toHaveBeenCalled();
  });

  test('operatorId 無しの PUT (status更新等) は従来通り通る', async () => {
    chatRows.set('friend-1', makeChatRow('friend-1'));

    const res = await app(STAFF_A).request(
      '/api/chats/friend-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'waiting_reply' }),
      },
      { DB: fakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'token' } as unknown as Env['Bindings'],
    );

    expect(res.status).toBe(200);
    expect(chatRows.get('friend-1')!.status).toBe('waiting_reply');
  });
});
