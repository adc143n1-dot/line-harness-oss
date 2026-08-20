import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', () => ({ jstNow: vi.fn(() => '2026-08-20T21:00:00.000+09:00') }));

const discordOAuthMocks = vi.hoisted(() => ({
  discordOAuthConfigured: vi.fn(() => true),
  exchangeDiscordCode: vi.fn(async () => ({ id: 'discord-user-1', username: 'taro' })),
}));
vi.mock('../services/discord-oauth.js', () => discordOAuthMocks);

import { discordLink } from './discord-link.js';
import type { Env } from '../index.js';

type Token = { friend_id: string; used_at: string | null; revoked_at: string | null; expires_at: string };

/** 条件付き UPDATE の semantics (used_at IS NULL / revoked_at IS NULL / expires_at > now) を再現する */
function fakeDb(tokens: Record<string, Token>) {
  const friendUpdates: Array<{ discordUserId: string; friendId: string }> = [];
  let linkShouldFail = false;
  const db = {
    prepare(sql: string) {
      const st = {
        params: [] as unknown[],
        bind(...p: unknown[]) { st.params = p; return st; },
        async run() {
          if (sql.includes('UPDATE discord_invite_tokens SET used_at')) {
            const [usedAt, token, now] = st.params as string[];
            const t = tokens[token];
            const claimable = !!t && t.used_at === null && t.revoked_at === null && t.expires_at > now;
            if (claimable) t.used_at = usedAt;
            return { meta: { changes: claimable ? 1 : 0 } };
          }
          if (sql.includes('UPDATE friends SET discord_user_id')) {
            if (linkShouldFail) throw new Error('UNIQUE constraint failed: friends.discord_user_id');
            const [discordUserId, , friendId] = st.params as string[];
            friendUpdates.push({ discordUserId, friendId });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes('SELECT friend_id FROM discord_invite_tokens')) {
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
  a.route('/', discordLink);
  return a;
}

const VALID = { friend_id: 'friend-1', used_at: null, revoked_at: null, expires_at: '2026-08-21T21:00:00.000+09:00' };
const BASE_ENV = { DISCORD_OAUTH_CLIENT_ID: 'client-1', DISCORD_OAUTH_CLIENT_SECRET: 'secret-1' };

function get(a: ReturnType<typeof app>, env: Partial<Env['Bindings']>, query: string) {
  return a.request(`/discord/callback?${query}`, {}, env as unknown as Env['Bindings']);
}

beforeEach(() => {
  vi.clearAllMocks();
  discordOAuthMocks.discordOAuthConfigured.mockReturnValue(true);
  discordOAuthMocks.exchangeDiscordCode.mockResolvedValue({ id: 'discord-user-1', username: 'taro' });
});

describe('GET /discord/callback — 入力検証', () => {
  test('code も state も無ければ 200 でエラーページを返し、紐付けない', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await get(app(), { ...BASE_ENV, DB: db }, '');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('リクエストが不正です');
    expect(friendUpdates).toHaveLength(0);
  });

  test('Discord側が error= を返した場合はキャンセル扱いにする', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await get(app(), { ...BASE_ENV, DB: db }, 'error=access_denied');
    expect(await res.text()).toContain('キャンセル');
    expect(friendUpdates).toHaveLength(0);
  });

  test('OAuth未設定なら紐付けずにエラーページを返す', async () => {
    discordOAuthMocks.discordOAuthConfigured.mockReturnValue(false);
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await get(app(), { DB: db }, 'code=abc&state=tok');
    expect(await res.text()).toContain('設定エラー');
    expect(friendUpdates).toHaveLength(0);
    expect(discordOAuthMocks.exchangeDiscordCode).not.toHaveBeenCalled();
  });
});

describe('GET /discord/callback — トークン検証・紐付け', () => {
  test('有効なトークンで friend に discord_user_id を記録する', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('連携が完了しました');
    expect(friendUpdates).toEqual([{ discordUserId: 'discord-user-1', friendId: 'friend-1' }]);
  });

  test('使用済みトークンでは紐付けない (コード交換も行わない)', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID, used_at: '2026-08-20T20:00:00.000+09:00' } });
    const res = await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');
    expect(await res.text()).toContain('リンクが無効です');
    expect(friendUpdates).toHaveLength(0);
    expect(discordOAuthMocks.exchangeDiscordCode).not.toHaveBeenCalled();
  });

  test('期限切れトークンでは紐付けない', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID, expires_at: '2026-08-19T21:00:00.000+09:00' } });
    await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');
    expect(friendUpdates).toHaveLength(0);
  });

  test('失効させたトークンでは紐付けない', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID, revoked_at: '2026-08-20T20:00:00.000+09:00' } });
    await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');
    expect(friendUpdates).toHaveLength(0);
  });

  test('同じリンクを二度開いても 2 回目は紐付けない (トークンは消費済み)', async () => {
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');
    await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');
    expect(friendUpdates).toHaveLength(1);
  });

  test('コード交換に失敗したら 200 でエラーページを返す', async () => {
    discordOAuthMocks.exchangeDiscordCode.mockRejectedValue(new Error('discord_token_exchange_failed'));
    const { db, friendUpdates } = fakeDb({ tok: { ...VALID } });
    const res = await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('連携に失敗しました');
    expect(friendUpdates).toHaveLength(0);
  });

  test('既に別の友だちに紐付いた Discord アカウントでも 200 を返す (再送ループにしない)', async () => {
    const { db, failLink } = fakeDb({ tok: { ...VALID } });
    failLink();
    const res = await get(app(), { ...BASE_ENV, DB: db }, 'code=abc&state=tok');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('連携できませんでした');
  });
});
