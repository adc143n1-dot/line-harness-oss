import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', () => ({
  jstNow: vi.fn(() => '2026-08-18T21:00:00.000+09:00'),
}));

import { telegram } from './telegram.js';
import type { Env } from '../index.js';

type Token = { friend_id: string; used_at: string | null; revoked_at: string | null; expires_at: string };

/** 条件付き UPDATE の semantics (used_at IS NULL / revoked_at IS NULL / expires_at > now) を再現する */
function fakeDb(tokens: Record<string, Token>) {
  const friendUpdates: Array<{ telegramUserId: string; friendId: string }> = [];
  let linkShouldFail = false;
  const db = {
    prepare(sql: string) {
      const st = {
        params: [] as unknown[],
        bind(...p: unknown[]) { st.params = p; return st; },
        async run() {
          if (sql.includes('UPDATE tg_invite_tokens SET used_at')) {
            const [usedAt, token, now] = st.params as string[];
            const t = tokens[token];
            const claimable = !!t && t.used_at === null && t.revoked_at === null && t.expires_at > now;
            if (claimable) t.used_at = usedAt;
            return { meta: { changes: claimable ? 1 : 0 } };
          }
          if (sql.includes('UPDATE friends SET telegram_user_id')) {
            if (linkShouldFail) throw new Error('UNIQUE constraint failed: friends.telegram_user_id');
            const [telegramUserId, , friendId] = st.params as string[];
            friendUpdates.push({ telegramUserId, friendId });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes('SELECT friend_id FROM tg_invite_tokens')) {
            const t = tokens[st.params[0] as string];
            return t ? { friend_id: t.friend_id } : null;
          }
          return null;
        },
      };
      return st;
    },
  };
  return {
    db: db as unknown as D1Database,
    friendUpdates,
    failLink: () => { linkShouldFail = true; },
  };
}

function app() {
  const a = new Hono<Env>();
  a.route('/', telegram);
  return a;
}

const VALID = { friend_id: 'friend-1', used_at: null, revoked_at: null, expires_at: '2026-08-19T21:00:00.000+09:00' };

function post(a: ReturnType<typeof app>, env: Partial<Env['Bindings']>, headers: Record<string, string>, body: unknown) {
  return a.request(
    '/api/telegram/webhook',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
    env as unknown as Env['Bindings'],
  );
}

const startBody = (token: string) => ({
  message: { text: `/start ${token}`, from: { id: 12345 }, chat: { id: 999 } },
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
});

describe('POST /api/telegram/webhook — 送信元の検証', () => {
  test('TELEGRAM_WEBHOOK_SECRET が未設定なら全リクエストを拒否する (fail closed)', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await post(app(), { DB: db, TELEGRAM_BOT_TOKEN: 'bot' }, {}, startBody('tok'));

    expect(res.status).toBe(401);
    expect(friendUpdates).toHaveLength(0);
  });

  test('secret_token が一致しないリクエストを拒否する', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await post(
      app(),
      { DB: db, TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_WEBHOOK_SECRET: 'right' },
      { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
      startBody('tok'),
    );

    expect(res.status).toBe(401);
    expect(friendUpdates).toHaveLength(0);
  });
});

describe('POST /api/telegram/webhook — /start による紐付け', () => {
  const env = { TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_WEBHOOK_SECRET: 'right' };
  const hdr = { 'X-Telegram-Bot-Api-Secret-Token': 'right' };

  test('有効なトークンで friend に telegram_user_id を記録する', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await post(app(), { ...env, DB: db }, hdr, startBody('tok'));

    expect(res.status).toBe(200);
    expect(friendUpdates).toEqual([{ telegramUserId: '12345', friendId: 'friend-1' }]);
  });

  test('使用済みトークンでは紐付けない', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID, used_at: '2026-08-18T20:00:00.000+09:00' } });
    await post(app(), { ...env, DB: db }, hdr, startBody('tok'));
    expect(friendUpdates).toHaveLength(0);
  });

  test('期限切れトークンでは紐付けない', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID, expires_at: '2026-08-17T21:00:00.000+09:00' } });
    await post(app(), { ...env, DB: db }, hdr, startBody('tok'));
    expect(friendUpdates).toHaveLength(0);
  });

  test('失効させたトークンでは紐付けない', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID, revoked_at: '2026-08-18T20:00:00.000+09:00' } });
    await post(app(), { ...env, DB: db }, hdr, startBody('tok'));
    expect(friendUpdates).toHaveLength(0);
  });

  test('同じリンクを二度タップしても 2 回目は紐付けない (トークンは消費済み)', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    await post(app(), { ...env, DB: db }, hdr, startBody('tok'));
    await post(app(), { ...env, DB: db }, hdr, startBody('tok'));
    expect(friendUpdates).toHaveLength(1);
  });

  test('既に別の友だちに紐付いた Telegram アカウントでも 200 を返し、再送ループにしない', async () => {
    const { db, failLink } = fakeDb({ tok: { ...VALID } });
    failLink();
    const res = await post(app(), { ...env, DB: db }, hdr, startBody('tok'));
    expect(res.status).toBe(200);
  });
});
