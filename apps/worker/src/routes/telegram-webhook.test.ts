import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const dbMocks = vi.hoisted(() => ({
  jstNow: vi.fn(() => '2026-08-23T10:00:00.000+09:00'),
  getTelegramAccountById: vi.fn(),
  upsertTelegramFriend: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getChatByFriendId: vi.fn(async () => ({ operator_id: null })),
}));
vi.mock('@line-crm/db', () => dbMocks);

const busMocks = vi.hoisted(() => ({ fireEvent: vi.fn() }));
vi.mock('../services/event-bus.js', () => busMocks);

const autoReplyMocks = vi.hoisted(() => ({ keywordMatches: vi.fn(() => false) }));
vi.mock('../services/auto-reply.js', () => autoReplyMocks);

const aiMocks = vi.hoisted(() => ({ maybeSendAiReply: vi.fn(async () => ({ sent: false })) }));
vi.mock('../services/ai-reply/index.js', () => aiMocks);

const dispatchMocks = vi.hoisted(() => ({ deliverToFriend: vi.fn(async () => ({ ok: true })) }));
vi.mock('../services/messaging/dispatch.js', () => dispatchMocks);

const tgMocks = vi.hoisted(() => ({
  sendText: vi.fn(async () => true),
  fetchAndStorePhoto: vi.fn(async () => null),
}));
vi.mock('../services/telegram/client.js', () => ({
  TelegramClient: class {
    sendText = tgMocks.sendText;
    fetchAndStorePhoto = tgMocks.fetchAndStorePhoto;
  },
}));

import { telegram } from './telegram.js';

const ACCOUNT = {
  id: 'acc1',
  bot_token: 'BOT',
  bot_username: 'b',
  webhook_secret: 'SEK',
  name: 'n',
  is_active: 1,
  country: null,
  display_order: 0,
  created_at: '',
  updated_at: '',
};

function fakeDb() {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const st = {
        params: [] as unknown[],
        bind(...p: unknown[]) { st.params = p; return st; },
        async run() { inserts.push({ sql, params: st.params }); return { success: true }; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
      return st;
    },
  };
  return { db: db as unknown as D1Database, inserts };
}

function app(db: D1Database) {
  const a = new Hono<Env>();
  a.route('/', telegram);
  return (body: unknown, secret: string) =>
    a.request('/api/telegram/webhook/acc1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(body),
    }, { DB: db, IMAGES: {}, WORKER_URL: 'https://w' } as unknown as Env['Bindings']);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getTelegramAccountById.mockResolvedValue(ACCOUNT);
  dbMocks.upsertTelegramFriend.mockResolvedValue({ id: 'friend-tg-1', channel: 'telegram', telegram_chat_id: '999', telegram_account_id: 'acc1' });
  dbMocks.getChatByFriendId.mockResolvedValue({ operator_id: null });
});

describe('POST /api/telegram/webhook/:accountId', () => {
  const textUpdate = { message: { text: 'こんにちは', from: { id: 12345, first_name: '太郎' }, chat: { id: 999 } } };

  it('wrong secret → 401, no processing', async () => {
    const { db } = fakeDb();
    const res = await app(db)(textUpdate, 'WRONG');
    expect(res.status).toBe(401);
    expect(dbMocks.upsertTelegramFriend).not.toHaveBeenCalled();
  });

  it('unknown/inactive account → 401', async () => {
    dbMocks.getTelegramAccountById.mockResolvedValue(null);
    const { db } = fakeDb();
    const res = await app(db)(textUpdate, 'SEK');
    expect(res.status).toBe(401);
  });

  it('valid text → upserts Telegram friend, logs incoming, upserts chat, fires event', async () => {
    const { db, inserts } = fakeDb();
    const res = await app(db)(textUpdate, 'SEK');
    expect(res.status).toBe(200);
    expect(dbMocks.upsertTelegramFriend).toHaveBeenCalledWith(db, {
      telegramAccountId: 'acc1',
      telegramUserId: '12345',
      telegramChatId: '999',
      displayName: '太郎',
    });
    const log = inserts.find((q) => q.sql.includes('INSERT INTO messages_log'));
    expect(log).toBeDefined();
    expect(log!.sql).toContain("'incoming'");
    expect(log!.sql).toContain("'telegram'");
    expect(dbMocks.upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-tg-1');
    expect(busMocks.fireEvent).toHaveBeenCalled();
    // 自動化(AI応答)が走る (operator未割当・キーワード不一致)
    expect(aiMocks.maybeSendAiReply).toHaveBeenCalled();
  });

  it('/start greets and does not log a chat message', async () => {
    const { db, inserts } = fakeDb();
    const res = await app(db)({ message: { text: '/start', from: { id: 1 }, chat: { id: 2 } } }, 'SEK');
    expect(res.status).toBe(200);
    expect(tgMocks.sendText).toHaveBeenCalled();
    expect(inserts.find((q) => q.sql.includes('INSERT INTO messages_log'))).toBeUndefined();
  });

  it('bot messages are ignored', async () => {
    const { db } = fakeDb();
    const res = await app(db)({ message: { text: 'hi', from: { id: 1, is_bot: true }, chat: { id: 2 } } }, 'SEK');
    expect(res.status).toBe(200);
    expect(dbMocks.upsertTelegramFriend).not.toHaveBeenCalled();
  });

  it('keyword auto-reply (text) responds and skips AI', async () => {
    autoReplyMocks.keywordMatches.mockReturnValue(true);
    const { db } = fakeDb();
    // auto_replies クエリ結果を1件返す
    (db.prepare as unknown) = (sql: string) => ({
      params: [] as unknown[],
      bind(...p: unknown[]) { (this as { params: unknown[] }).params = p; return this; },
      async run() { return { success: true }; },
      async first() { return null; },
      async all() {
        if (sql.includes('FROM auto_replies')) {
          return { results: [{ id: 'r1', response_type: 'text', response_content: '自動返信です', is_active: 1 }] };
        }
        return { results: [] };
      },
    });
    const res = await app(db)(textUpdate, 'SEK');
    expect(res.status).toBe(200);
    expect(dispatchMocks.deliverToFriend).toHaveBeenCalled();
    expect(aiMocks.maybeSendAiReply).not.toHaveBeenCalled();
  });
});
