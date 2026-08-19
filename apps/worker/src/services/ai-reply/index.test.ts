import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('../event-bus.js', () => ({ logOutgoingMessage: vi.fn(), fireEvent: vi.fn() }));

import { logOutgoingMessage, fireEvent } from '../event-bus.js';
import { maybeSendAiReply } from './index.js';
import type { AiReplyProvider } from './provider.js';

function fakeFriend(overrides: Partial<{ id: string; line_user_id: string }> = {}) {
  return { id: 'friend-1', line_user_id: 'U-1', ...overrides } as unknown as import('@line-crm/db').Friend;
}

function fakeHistoryDb(rows: Array<{ direction: string; message_type: string; content: string }>) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: rows }),
      })),
    })),
  } as unknown as D1Database;
}

/**
 * account_settings / messages_log への first()/all() 呼び出しを SQL 文字列で
 * 振り分ける汎用フェイク。アカウント別トグルと日次上限のテストで使う。
 */
function fakeAccountAwareDb(opts: {
  historyRows?: Array<{ direction: string; message_type: string; content: string }>;
  aiReplyEnabledValue?: string; // account_settings.ai_reply_enabled の value (無ければ未設定)
  dailyLimitValue?: string; // account_settings.ai_reply_daily_limit の value
  aiReplyCountToday?: number; // messages_log の COUNT(*)
}) {
  const historyRows = opts.historyRows ?? [];
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: historyRows }),
        first: vi.fn().mockImplementation(() => {
          if (sql.includes("key = 'ai_reply_enabled'")) {
            return opts.aiReplyEnabledValue === undefined
              ? Promise.resolve(null)
              : Promise.resolve({ value: opts.aiReplyEnabledValue });
          }
          if (sql.includes("key = 'ai_reply_daily_limit'")) {
            return opts.dailyLimitValue === undefined
              ? Promise.resolve(null)
              : Promise.resolve({ value: opts.dailyLimitValue });
          }
          if (sql.includes('COUNT(*) AS n')) {
            return Promise.resolve({ n: opts.aiReplyCountToday ?? 0 });
          }
          // 上限アラート済みフラグ (ai_reply_limit_alert_sent_date) はデフォルトで
          // 未送信 (null) 扱いにする — テストごとに明示指定しない限りアラートが発火する。
          return Promise.resolve(null);
        }),
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    })),
  } as unknown as D1Database;
}

function fakeLineClient(push: ReturnType<typeof vi.fn> = vi.fn()) {
  return { pushTextMessage: push } as unknown as import('@line-crm/line-sdk').LineClient;
}

class StubProvider implements AiReplyProvider {
  constructor(private readonly reply: string | Error) {}
  async generateReply() {
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

beforeEach(() => {
  vi.mocked(logOutgoingMessage).mockClear();
});

describe('maybeSendAiReply — 発動条件', () => {
  test('AI_REPLY_ENABLED が true でなければ何もしない', async () => {
    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeHistoryDb([]),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      { AI_REPLY_ENABLED: 'false', ANTHROPIC_API_KEY: 'key' },
    );

    expect(result).toEqual({ sent: false, reason: 'disabled' });
    expect(push).not.toHaveBeenCalled();
  });

  test('担当スタッフが付いているチャットには送らない (有人対応を優先)', async () => {
    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeHistoryDb([]),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: 'staff-7' },
      'こんにちは',
      { AI_REPLY_ENABLED: 'true', ANTHROPIC_API_KEY: 'key' },
    );

    expect(result).toEqual({ sent: false, reason: 'operator_assigned' });
    expect(push).not.toHaveBeenCalled();
  });

  test('プロバイダが未設定 (API キー未設定) なら送らない', async () => {
    const result = await maybeSendAiReply(
      fakeHistoryDb([]),
      fakeLineClient(),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      { AI_REPLY_ENABLED: 'true' },
    );

    expect(result).toEqual({ sent: false, reason: 'provider_not_configured' });
  });
});

describe('maybeSendAiReply — 送信とログ記録', () => {
  test('生成に成功したら push で送信し、source=ai_reply でログする', async () => {
    // provider の差し替えは buildProvider 内部なので、ここでは
    // ANTHROPIC_API_KEY を渡して実プロバイダ経路を通すのではなく、
    // fetch をスタブして Anthropic 呼び出し自体を検証する。
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ご案内します。' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const push = vi.fn();
    const result = await maybeSendAiReply(
      // SQL は ORDER BY created_at DESC で返す (最新が先頭) 想定なので、
      // fake も新しい順で渡す。
      fakeHistoryDb([
        { direction: 'outgoing', message_type: 'text', content: '概算をお伝えしますね' },
        { direction: 'incoming', message_type: 'text', content: '料金は？' },
      ]),
      fakeLineClient(push),
      fakeFriend({ line_user_id: 'U-42' }),
      { operator_id: null },
      '今日中にお願いできますか',
      { AI_REPLY_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' },
    );

    expect(result).toEqual({ sent: true });
    expect(push).toHaveBeenCalledWith('U-42', 'ご案内します。');
    expect(logOutgoingMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'ai_reply', content: 'ご案内します。', deliveryType: 'push' }),
    );

    // 履歴 (直近2件) + 今回のメッセージが順序どおり渡っていること
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.messages).toEqual([
      { role: 'user', content: '料金は？' },
      { role: 'assistant', content: '概算をお伝えしますね' },
      { role: 'user', content: '今日中にお願いできますか' },
    ]);

    vi.unstubAllGlobals();
  });

  test('生成に失敗しても例外を投げず、push もログも行わない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));

    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeHistoryDb([]),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      { AI_REPLY_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' },
    );

    expect(result).toEqual({ sent: false, reason: 'generation_failed' });
    expect(push).not.toHaveBeenCalled();
    expect(logOutgoingMessage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  test('push 送信に失敗したらログを残さない (実際に届いていないため)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
      ),
    );
    const push = vi.fn().mockRejectedValue(new Error('LINE push failed'));

    const result = await maybeSendAiReply(
      fakeHistoryDb([]),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      { AI_REPLY_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' },
    );

    expect(result).toEqual({ sent: false, reason: 'push_failed' });
    expect(logOutgoingMessage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('maybeSendAiReply — アカウント別トグルと日次上限', () => {
  const env = { AI_REPLY_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
      ),
    );
  });

  test('アカウント設定が未設定ならマスタースイッチどおり送る', async () => {
    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeAccountAwareDb({}),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      env,
      { lineAccountId: 'acct-1' },
    );

    expect(result).toEqual({ sent: true });
    expect(push).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("アカウント別に 'false' が設定されていたら送らない", async () => {
    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeAccountAwareDb({ aiReplyEnabledValue: 'false' }),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      env,
      { lineAccountId: 'acct-1' },
    );

    expect(result).toEqual({ sent: false, reason: 'account_disabled' });
    expect(push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('日次上限に達していたら送らない', async () => {
    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeAccountAwareDb({ dailyLimitValue: '5', aiReplyCountToday: 5 }),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      env,
      { lineAccountId: 'acct-1' },
    );

    expect(result).toEqual({ sent: false, reason: 'daily_limit_reached' });
    expect(push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('日次上限未満なら送る', async () => {
    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeAccountAwareDb({ dailyLimitValue: '5', aiReplyCountToday: 4 }),
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      env,
      { lineAccountId: 'acct-1' },
    );

    expect(result).toEqual({ sent: true });
    expect(push).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('lineAccountId が無ければアカウント別設定は見ない (グローバル運用)', async () => {
    const push = vi.fn();
    const result = await maybeSendAiReply(
      fakeAccountAwareDb({ aiReplyEnabledValue: 'false' }), // DB は見に行かないので影響しないはず
      fakeLineClient(push),
      fakeFriend(),
      { operator_id: null },
      'こんにちは',
      env,
      {},
    );

    expect(result).toEqual({ sent: true });
    vi.unstubAllGlobals();
  });
});

describe('maybeSendAiReply — 日次上限到達アラート', () => {
  const env = { AI_REPLY_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' };

  function fakeDbWithAlertState(opts: {
    dailyLimitValue: string;
    aiReplyCountToday: number;
    alertAlreadySentDate?: string;
  }) {
    const runCalls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const stmt = {
          params: [] as unknown[],
          bind: vi.fn((...p: unknown[]) => { stmt.params = p; return stmt; }),
          first: vi.fn(async () => {
            if (sql.includes("key = 'ai_reply_daily_limit'")) return { value: opts.dailyLimitValue };
            if (sql.includes('COUNT(*) AS n')) return { n: opts.aiReplyCountToday };
            // getAccountSetting() は汎用ヘルパーで、key をリテラルではなく
            // バインドパラメータ (`key = ?`) として渡す。SQL 文字列にキー名は
            // 現れないため、params 側で判定する。
            if (sql.includes('account_settings') && sql.includes('key = ?')) {
              const key = stmt.params[1];
              if (key === 'ai_reply_limit_alert_sent_date') {
                return opts.alertAlreadySentDate ? { value: opts.alertAlreadySentDate } : null;
              }
            }
            return null;
          }),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => { runCalls.push({ sql, params: stmt.params }); return { success: true }; }),
        };
        return stmt;
      }),
    };
    return { db: db as unknown as D1Database, runCalls };
  }

  test('上限到達時、初回は fireEvent でアラートを送る', async () => {
    vi.mocked(fireEvent).mockClear();
    const { db } = fakeDbWithAlertState({ dailyLimitValue: '5', aiReplyCountToday: 5 });

    const result = await maybeSendAiReply(
      db, fakeLineClient(), fakeFriend(), { operator_id: null }, 'こんにちは', env, { lineAccountId: 'acct-1' },
    );

    expect(result).toEqual({ sent: false, reason: 'daily_limit_reached' });
    expect(fireEvent).toHaveBeenCalledTimes(1);
    const [, eventType, payload] = vi.mocked(fireEvent).mock.calls[0];
    expect(eventType).toBe('ai_reply_daily_limit_reached');
    expect(payload).toMatchObject({ eventData: { lineAccountId: 'acct-1', limit: 5, count: 5 } });
  });

  test('同日中に2回目到達しても再送しない', async () => {
    vi.mocked(fireEvent).mockClear();
    const today = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
    const { db } = fakeDbWithAlertState({
      dailyLimitValue: '5', aiReplyCountToday: 7, alertAlreadySentDate: today,
    });

    await maybeSendAiReply(
      db, fakeLineClient(), fakeFriend(), { operator_id: null }, 'こんにちは', env, { lineAccountId: 'acct-1' },
    );

    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('上限未到達なら fireEvent を呼ばない', async () => {
    vi.mocked(fireEvent).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })),
    );
    const { db } = fakeDbWithAlertState({ dailyLimitValue: '5', aiReplyCountToday: 2 });

    await maybeSendAiReply(
      db, fakeLineClient(), fakeFriend(), { operator_id: null }, 'こんにちは', env, { lineAccountId: 'acct-1' },
    );

    expect(fireEvent).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
