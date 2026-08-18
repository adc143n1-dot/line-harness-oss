import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { ENV_OWNER_STAFF_ID, type AuthenticatedStaff } from '../middleware/auth.js';
import type { Env } from '../index.js';

vi.mock('@line-crm/db', () => ({
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(async () => ({
    id: 'chat-1',
    friend_id: 'friend-1',
    operator_id: null,
    status: 'unread',
    notes: null,
    last_message_at: null,
    created_at: '2026-08-18T10:00:00.000+09:00',
    updated_at: '2026-08-18T10:00:00.000+09:00',
  })),
  createChat: vi.fn(),
  getFriendById: vi.fn(async () => ({
    id: 'friend-1',
    line_user_id: 'U-line-1',
    line_account_id: null,
  })),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => '2026-08-18T21:00:00.000+09:00'),
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    async pushTextMessage() {}
    async pushFlexMessage() {}
    async pushImageMessage() {}
  },
}));

import { chats } from './chats.js';

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
