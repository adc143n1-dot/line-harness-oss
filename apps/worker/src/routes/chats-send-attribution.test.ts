import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { ENV_OWNER_STAFF_ID, type AuthenticatedStaff } from '../middleware/auth.js';
import type { Env } from '../index.js';

const chatRow: Record<string, unknown> = {
  id: 'chat-1',
  friend_id: 'friend-1',
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
  created_at: '2026-08-18T10:00:00.000+09:00',
  updated_at: '2026-08-18T10:00:00.000+09:00',
};

vi.mock('@line-crm/db', () => ({
  getChats: vi.fn(),
  getChatById: vi.fn(async () => chatRow),
  createChat: vi.fn(),
  getFriendById: vi.fn(async () => ({
    id: 'friend-1',
    line_user_id: 'U-line-1',
    line_account_id: null,
  })),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(async () => true),
  jstNow: vi.fn(() => '2026-08-18T21:00:00.000+09:00'),
}));

const lineMocks = vi.hoisted(() => ({ pushTextMessage: vi.fn(), pushFlexMessage: vi.fn(), pushImageMessage: vi.fn() }));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushTextMessage = lineMocks.pushTextMessage;
    pushFlexMessage = lineMocks.pushFlexMessage;
    pushImageMessage = lineMocks.pushImageMessage;
  },
}));

import { chats } from './chats.js';
import { updateChat } from '@line-crm/db';

type Insert = { sql: string; params: unknown[] };

function fakeDb() {
  const inserts: Insert[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async run() {
          inserts.push({ sql, params: statement.params });
          return { success: true };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, inserts };
}

async function send(staff: AuthenticatedStaff | undefined) {
  const { db, inserts } = fakeDb();
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (staff) c.set('staff', staff);
    await next();
  });
  app.route('/', chats);

  const res = await app.request(
    '/api/chats/chat-1/send',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageType: 'text', content: 'hello' }),
    },
    { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token' } as unknown as Env['Bindings'],
  );

  const messageInsert = inserts.find((q) => q.sql.includes('INSERT INTO messages_log'));
  return { res, messageInsert };
}

describe('POST /api/chats/:id/send — 送信者の記録', () => {
  test('実在するスタッフの id を sent_by_staff_id に記録する', async () => {
    const { res, messageInsert } = await send({ id: 'staff-7', name: 'Aoi', role: 'staff' });

    expect(res.status).toBe(200);
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.sql).toContain('sent_by_staff_id');
    // bind 順: id, friend_id, message_type, content, sent_by_staff_id, created_at
    expect(messageInsert!.params[4]).toBe('staff-7');
  });

  test('env API_KEY 認証の合成 ID は staff_members に実在しないため NULL にする', async () => {
    const { res, messageInsert } = await send({
      id: ENV_OWNER_STAFF_ID,
      name: 'Owner',
      role: 'owner',
    });

    expect(res.status).toBe(200);
    expect(messageInsert!.params[4]).toBeNull();
  });

  test('スタッフ情報が無い場合も NULL で送信自体は成功する', async () => {
    const { res, messageInsert } = await send(undefined);

    expect(res.status).toBe(200);
    expect(messageInsert!.params[4]).toBeNull();
  });
});

describe('POST /api/chats/:id/send — 計測列の記録', () => {
  test('スタッフ返信で last_replied_by=operator と last_activity_at を記録する', async () => {
    chatRow.first_response_at = null;
    vi.mocked(updateChat).mockClear();

    await send({ id: 'staff-7', name: 'Aoi', role: 'staff' });

    const updates = vi.mocked(updateChat).mock.calls[0][2];
    expect(updates.lastRepliedBy).toBe('operator');
    expect(updates.lastActivityAt).toBe('2026-08-18T21:00:00.000+09:00');
    expect(updates.status).toBe('in_progress');
  });

  test('初回のスタッフ返信でのみ first_response_at を記録する', async () => {
    chatRow.first_response_at = null;
    vi.mocked(updateChat).mockClear();
    await send({ id: 'staff-7', name: 'Aoi', role: 'staff' });
    expect(vi.mocked(updateChat).mock.calls[0][2].firstResponseAt).toBe(
      '2026-08-18T21:00:00.000+09:00',
    );

    // すでに初回応答済みのチャットでは上書きしない (初回応答時間が壊れるため)
    chatRow.first_response_at = '2026-08-18T11:00:00.000+09:00';
    vi.mocked(updateChat).mockClear();
    await send({ id: 'staff-7', name: 'Aoi', role: 'staff' });
    expect(vi.mocked(updateChat).mock.calls[0][2]).not.toHaveProperty('firstResponseAt');
  });
});

describe('PUT /api/chats/:id — 更新できる項目の制限', () => {
  async function put(body: unknown) {
    const { db } = fakeDb();
    const app = new Hono<Env>();
    app.route('/', chats);
    vi.mocked(updateChat).mockClear();
    const res = await app.request(
      '/api/chats/chat-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token' } as unknown as Env['Bindings'],
    );
    return { res, updates: vi.mocked(updateChat).mock.calls[0]?.[2] };
  }

  test('status と outcome を独立して更新できる', async () => {
    const { res, updates } = await put({ status: 'waiting_reply', outcome: 'converted' });

    expect(res.status).toBe(200);
    expect(updates).toMatchObject({ status: 'waiting_reply', outcome: 'converted' });
  });

  test('outcome は null で解除できる', async () => {
    const { updates } = await put({ outcome: null });
    expect(updates).toMatchObject({ outcome: null });
  });

  test('計測列はクライアントから書き換えられない', async () => {
    // KPI (初回応答時間・解決時刻) をクライアントが詐称できてはいけない
    const { updates } = await put({
      status: 'resolved',
      assignedAt: '1999-01-01T00:00:00.000+09:00',
      firstResponseAt: '1999-01-01T00:00:00.000+09:00',
      lastRepliedBy: 'user',
      version: 999,
    });

    expect(updates).not.toHaveProperty('assignedAt');
    expect(updates).not.toHaveProperty('firstResponseAt');
    expect(updates).not.toHaveProperty('lastRepliedBy');
    expect(updates).not.toHaveProperty('version');
    // resolved への遷移で resolvedAt はサーバ側が導出する
    expect(updates).toHaveProperty('resolvedAt');
  });
});

describe('POST /api/chats/:id/claim — 自分に引き取る', () => {
  async function claim(staff: AuthenticatedStaff | undefined, body: unknown = {}) {
    const { db } = fakeDb();
    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      if (staff) c.set('staff', staff);
      await next();
    });
    app.route('/', chats);
    vi.mocked(updateChat).mockClear();
    const res = await app.request(
      '/api/chats/chat-1/claim',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token' } as unknown as Env['Bindings'],
    );
    return { res, updates: vi.mocked(updateChat).mock.calls[0]?.[2], opts: vi.mocked(updateChat).mock.calls[0]?.[3] };
  }

  test('未割当なら自分に割り当て、未読は対応中にする', async () => {
    chatRow.operator_id = null;
    chatRow.status = 'unread';
    chatRow.version = 3;

    const { res, updates, opts } = await claim({ id: 'staff-7', name: 'Aoi', role: 'staff' });

    expect(res.status).toBe(200);
    expect(updates).toMatchObject({ operatorId: 'staff-7', status: 'in_progress' });
    // 読んだ version を条件に入れて書く (楽観ロック)
    expect(opts).toEqual({ expectedVersion: 3 });
  });

  test('他のスタッフが持っているチャットは 409 で拒否する', async () => {
    chatRow.operator_id = 'staff-other';
    chatRow.status = 'in_progress';

    const { res, updates } = await claim({ id: 'staff-7', name: 'Aoi', role: 'staff' });

    expect(res.status).toBe(409);
    expect(updates).toBeUndefined();
  });

  test('force 指定なら他のスタッフからでも引き取れる', async () => {
    chatRow.operator_id = 'staff-other';

    const { res, updates } = await claim({ id: 'staff-7', name: 'Aoi', role: 'staff' }, { force: true });

    expect(res.status).toBe(200);
    expect(updates).toMatchObject({ operatorId: 'staff-7' });
  });

  test('共有 API キー (staff_members に実在しない合成 ID) では担当者になれない', async () => {
    chatRow.operator_id = null;

    const { res, updates } = await claim({ id: ENV_OWNER_STAFF_ID, name: 'Owner', role: 'owner' });

    expect(res.status).toBe(400);
    expect(updates).toBeUndefined();
  });

  test('読み込み後に他のスタッフが更新していたら 409 (version 不一致)', async () => {
    chatRow.operator_id = null;
    vi.mocked(updateChat).mockResolvedValueOnce(false);

    const { res } = await claim({ id: 'staff-7', name: 'Aoi', role: 'staff' });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/chats/:id/send — expectedVersion による衝突検知', () => {
  test('version が食い違うときは LINE に送信する前に 409 を返す', async () => {
    chatRow.version = 5;
    lineMocks.pushTextMessage.mockClear();

    const { db } = fakeDb();
    const app = new Hono<Env>();
    app.route('/', chats);
    const res = await app.request(
      '/api/chats/chat-1/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello', expectedVersion: 4 }),
      },
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token' } as unknown as Env['Bindings'],
    );

    expect(res.status).toBe(409);
    // 送ってから 409 にすると、相手には届いているのに UI 上は失敗になる
    expect(lineMocks.pushTextMessage).not.toHaveBeenCalled();
  });
});
