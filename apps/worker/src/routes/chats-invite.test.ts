import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthenticatedStaff } from '../middleware/auth.js';
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
  created_at: '2026-08-21T10:00:00.000+09:00',
  updated_at: '2026-08-21T10:00:00.000+09:00',
};

const friendRow: Record<string, unknown> = {
  id: 'friend-1',
  line_user_id: 'U-line-1',
  line_account_id: null,
  telegram_user_id: null,
  discord_user_id: null,
};

vi.mock('@line-crm/db', () => ({
  getChats: vi.fn(),
  getChatById: vi.fn(async () => chatRow),
  createChat: vi.fn(),
  getFriendById: vi.fn(async () => friendRow),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(async () => true),
  jstNow: vi.fn(() => '2026-08-21T21:00:00.000+09:00'),
  toJstString: vi.fn(() => '2026-08-22T21:00:00.000+09:00'),
}));

const lineMocks = vi.hoisted(() => ({ pushTextMessage: vi.fn() }));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushTextMessage = lineMocks.pushTextMessage;
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

async function post(
  path: string,
  env: Partial<Env['Bindings']> = {},
  staff?: AuthenticatedStaff,
) {
  const { db, inserts } = fakeDb();
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (staff) c.set('staff', staff);
    await next();
  });
  app.route('/', chats);

  const res = await app.request(
    path,
    { method: 'POST' },
    { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token', ...env } as unknown as Env['Bindings'],
  );
  return { res, inserts };
}

beforeEach(() => {
  vi.clearAllMocks();
  friendRow.telegram_user_id = null;
  friendRow.discord_user_id = null;
  friendRow.line_account_id = null;
  lineMocks.pushTextMessage.mockResolvedValue(undefined);
});

describe('POST /api/chats/:id/invite-telegram', () => {
  test('TELEGRAM_BOT_USERNAME 未設定なら 500', async () => {
    const { res } = await post('/api/chats/chat-1/invite-telegram', {});
    expect(res.status).toBe(500);
    expect(lineMocks.pushTextMessage).not.toHaveBeenCalled();
  });

  test('既に連携済みの友だちには 400 を返す', async () => {
    friendRow.telegram_user_id = 'tg-123';
    const { res } = await post('/api/chats/chat-1/invite-telegram', { TELEGRAM_BOT_USERNAME: 'my_bot' });
    expect(res.status).toBe(400);
    expect(lineMocks.pushTextMessage).not.toHaveBeenCalled();
  });

  test('未連携なら招待トークンを発行し、t.me の deep link を LINE で push する', async () => {
    const { res, inserts } = await post('/api/chats/chat-1/invite-telegram', { TELEGRAM_BOT_USERNAME: 'my_bot' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inviteUrl: string; expiresAt: string } };
    expect(body.data.inviteUrl).toContain('https://t.me/my_bot?start=');
    expect(body.data.expiresAt).toBe('2026-08-22T21:00:00.000+09:00');

    expect(lineMocks.pushTextMessage).toHaveBeenCalledTimes(1);
    const [lineUserId, message] = lineMocks.pushTextMessage.mock.calls[0];
    expect(lineUserId).toBe('U-line-1');
    expect(message).toContain('https://t.me/my_bot?start=');

    const tokenInsert = inserts.find((q) => q.sql.includes('INSERT INTO tg_invite_tokens'));
    expect(tokenInsert).toBeDefined();
    const revoke = inserts.find((q) => q.sql.includes('UPDATE tg_invite_tokens SET revoked_at'));
    expect(revoke).toBeDefined();

    const msgInsert = inserts.find((q) => q.sql.includes('INSERT INTO messages_log'));
    expect(msgInsert!.sql).toContain('manual');
  });

  test('再発行前に未使用・未失効の旧トークンを失効させる', async () => {
    const { inserts } = await post('/api/chats/chat-1/invite-telegram', { TELEGRAM_BOT_USERNAME: 'my_bot' });
    const revoke = inserts.find((q) => q.sql.includes('UPDATE tg_invite_tokens SET revoked_at'));
    expect(revoke!.sql).toContain('used_at IS NULL AND revoked_at IS NULL');
    expect(revoke!.params[1]).toBe('friend-1');
  });

  test('チャットが見つからなければ 404', async () => {
    const { getChatById, getFriendById } = await import('@line-crm/db');
    vi.mocked(getChatById).mockResolvedValueOnce(null);
    vi.mocked(getFriendById).mockResolvedValueOnce(null as never);
    const { res } = await post('/api/chats/unknown/invite-telegram', { TELEGRAM_BOT_USERNAME: 'my_bot' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chats/:id/invite-discord', () => {
  test('OAuth未設定 (client_id/secret 無し) なら 500', async () => {
    const { res } = await post('/api/chats/chat-1/invite-discord', {});
    expect(res.status).toBe(500);
    expect(lineMocks.pushTextMessage).not.toHaveBeenCalled();
  });

  test('既に連携済みの友だちには 400 を返す', async () => {
    friendRow.discord_user_id = 'discord-123';
    const { res } = await post('/api/chats/chat-1/invite-discord', {
      DISCORD_OAUTH_CLIENT_ID: 'client-1',
      DISCORD_OAUTH_CLIENT_SECRET: 'secret-1',
    });
    expect(res.status).toBe(400);
    expect(lineMocks.pushTextMessage).not.toHaveBeenCalled();
  });

  test('未連携なら招待トークンを発行し、Discord認可URLを LINE で push する', async () => {
    const { res, inserts } = await post('/api/chats/chat-1/invite-discord', {
      DISCORD_OAUTH_CLIENT_ID: 'client-1',
      DISCORD_OAUTH_CLIENT_SECRET: 'secret-1',
      WORKER_URL: 'https://worker.example.com',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inviteUrl: string; expiresAt: string } };
    expect(body.data.inviteUrl).toContain('https://discord.com/api/oauth2/authorize');
    expect(body.data.inviteUrl).toContain('client_id=client-1');
    expect(body.data.inviteUrl).toContain('scope=identify');

    expect(lineMocks.pushTextMessage).toHaveBeenCalledTimes(1);
    const [lineUserId, message] = lineMocks.pushTextMessage.mock.calls[0];
    expect(lineUserId).toBe('U-line-1');
    expect(message).toContain('discord.com/api/oauth2/authorize');

    const tokenInsert = inserts.find((q) => q.sql.includes('INSERT INTO discord_invite_tokens'));
    expect(tokenInsert).toBeDefined();
    const revoke = inserts.find((q) => q.sql.includes('UPDATE discord_invite_tokens SET revoked_at'));
    expect(revoke).toBeDefined();
  });

  test('招待URLの state パラメータに発行したトークンをそのまま使う', async () => {
    const { inserts } = await post('/api/chats/chat-1/invite-discord', {
      DISCORD_OAUTH_CLIENT_ID: 'client-1',
      DISCORD_OAUTH_CLIENT_SECRET: 'secret-1',
    });
    const tokenInsert = inserts.find((q) => q.sql.includes('INSERT INTO discord_invite_tokens'));
    const token = tokenInsert!.params[0] as string;

    const [, message] = lineMocks.pushTextMessage.mock.calls[0];
    expect(message).toContain(`state=${token}`);
  });

  test('チャットが見つからなければ 404', async () => {
    const { getChatById, getFriendById } = await import('@line-crm/db');
    vi.mocked(getChatById).mockResolvedValueOnce(null);
    vi.mocked(getFriendById).mockResolvedValueOnce(null as never);
    const { res } = await post('/api/chats/unknown/invite-discord', {
      DISCORD_OAUTH_CLIENT_ID: 'client-1',
      DISCORD_OAUTH_CLIENT_SECRET: 'secret-1',
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chats/:id/invite-telegram, invite-discord — 送信者の記録', () => {
  test('スタッフとして送った場合も manual メッセージとして記録される', async () => {
    const { inserts } = await post(
      '/api/chats/chat-1/invite-telegram',
      { TELEGRAM_BOT_USERNAME: 'my_bot' },
      { id: 'staff-7', name: 'Aoi', role: 'staff' },
    );
    const msgInsert = inserts.find((q) => q.sql.includes('INSERT INTO messages_log'));
    // bind順: id, friend_id, content, sent_by_staff_id, created_at (direction/message_type/source はSQL側のリテラル)
    expect(msgInsert!.params[3]).toBe('staff-7');
  });

  test('更新後 updateChat が in_progress で呼ばれる', async () => {
    await post('/api/chats/chat-1/invite-discord', {
      DISCORD_OAUTH_CLIENT_ID: 'client-1',
      DISCORD_OAUTH_CLIENT_SECRET: 'secret-1',
    });
    expect(vi.mocked(updateChat)).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      expect.objectContaining({ status: 'in_progress', lastRepliedBy: 'operator' }),
    );
  });
});
