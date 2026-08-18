import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('../event-bus.js', () => ({ logOutgoingMessage: vi.fn() }));

import { logOutgoingMessage } from '../event-bus.js';
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
