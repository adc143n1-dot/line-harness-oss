import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const dbMocks = vi.hoisted(() => ({
  jstNow: vi.fn(() => '2026-08-28T10:00:00.000+09:00'),
  getPersonalLineAccountById: vi.fn(),
  upsertPersonalLineFriend: vi.fn(),
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

import { personalLine } from './personal-line.js';

const ACCOUNT = {
  id: 'acc1',
  name: 'n',
  bridge_base_url: 'https://bridge.example',
  bridge_secret: 'BSEK',
  inbound_secret: 'ISEK',
  is_active: 1,
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
  a.route('/', personalLine);
  return (body: unknown, secret: string) =>
    a.request('/api/personal-line/webhook/acc1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': secret },
      body: JSON.stringify(body),
    }, { DB: db, WORKER_URL: 'https://w' } as unknown as Env['Bindings']);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getPersonalLineAccountById.mockResolvedValue(ACCOUNT);
  dbMocks.upsertPersonalLineFriend.mockResolvedValue({
    id: 'friend-pl-1',
    channel: 'personal_line',
    personal_line_user_id: 'Umid123',
    personal_line_account_id: 'acc1',
  });
  dbMocks.getChatByFriendId.mockResolvedValue({ operator_id: null });
  // 送信ブリッジ(fetch)は成功扱いにしておく
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
});

describe('POST /api/personal-line/webhook/:accountId', () => {
  const textUpdate = {
    from: { userId: 'Umid123', displayName: '信長' },
    message: { type: 'text', text: 'こんにちは' },
  };

  it('wrong secret → 401, no processing', async () => {
    const { db } = fakeDb();
    const res = await app(db)(textUpdate, 'WRONG');
    expect(res.status).toBe(401);
    expect(dbMocks.upsertPersonalLineFriend).not.toHaveBeenCalled();
  });

  it('unknown/inactive account → 401', async () => {
    dbMocks.getPersonalLineAccountById.mockResolvedValue(null);
    const { db } = fakeDb();
    const res = await app(db)(textUpdate, 'ISEK');
    expect(res.status).toBe(401);
  });

  it('valid text → upserts friend, logs incoming, upserts chat, fires event, runs AI', async () => {
    const { db, inserts } = fakeDb();
    const res = await app(db)(textUpdate, 'ISEK');
    expect(res.status).toBe(200);
    expect(dbMocks.upsertPersonalLineFriend).toHaveBeenCalledWith(db, {
      personalLineAccountId: 'acc1',
      personalLineUserId: 'Umid123',
      displayName: '信長',
      pictureUrl: null,
    });
    const log = inserts.find((q) => q.sql.includes('INSERT INTO messages_log'));
    expect(log).toBeDefined();
    expect(log!.sql).toContain("'incoming'");
    expect(log!.sql).toContain("'personal_line'");
    expect(dbMocks.upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-pl-1');
    expect(busMocks.fireEvent).toHaveBeenCalled();
    expect(aiMocks.maybeSendAiReply).toHaveBeenCalled();
  });

  it('incomplete update (no from) is ignored', async () => {
    const { db } = fakeDb();
    const res = await app(db)({ message: { type: 'text', text: 'hi' } }, 'ISEK');
    expect(res.status).toBe(200);
    expect(dbMocks.upsertPersonalLineFriend).not.toHaveBeenCalled();
  });

  it('keyword auto-reply (text) responds and skips AI', async () => {
    autoReplyMocks.keywordMatches.mockReturnValue(true);
    const { db } = fakeDb();
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
    const res = await app(db)(textUpdate, 'ISEK');
    expect(res.status).toBe(200);
    expect(dispatchMocks.deliverToFriend).toHaveBeenCalled();
    expect(aiMocks.maybeSendAiReply).not.toHaveBeenCalled();
  });
});
