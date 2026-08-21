import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// このファイルは webhook.ts が副業マッチング (job-matching) の
// トリガー/postback処理を正しく呼び分けていることだけを検証する。
// 会話ステートマシン自体のロジックは job-matching/conversation.test.ts が
// 別途カバーしているので、ここでは「呼ばれるべき時に呼ばれ、呼ばれるべきで
// ない時に呼ばれない」ことに絞る。

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
  pushTextMessage: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getFriendById: vi.fn(),
  getScenarios: vi.fn().mockResolvedValue([]),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn().mockReturnValue('2026-08-21T21:00:00.000+09:00'),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  getMessageTemplateById: vi.fn(),
  getTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn().mockResolvedValue(true),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
  logOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

const jobMatchingMocks = vi.hoisted(() => ({
  isJobMatchingReferral: vi.fn(),
  beginJobMatchingConversation: vi.fn().mockResolvedValue(undefined),
  handleJobMatchingPostback: vi.fn(),
}));
vi.mock('../services/job-matching/conversation.js', () => jobMatchingMocks);

const autoReplyMocks = vi.hoisted(() => ({
  matchAndReply: vi.fn().mockResolvedValue({ matched: false, replyTokenConsumed: false }),
}));
vi.mock('../services/auto-reply.js', () => autoReplyMocks);

const aiReplyMocks = vi.hoisted(() => ({
  maybeSendAiReply: vi.fn().mockResolvedValue({ sent: false }),
  buildProvider: vi.fn(),
}));
vi.mock('../services/ai-reply/index.js', () => aiReplyMocks);

import { upsertFriend, getEntryRouteByRefCode } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { webhook } from './webhook.js';
import type { Env } from '../index.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

function recordingDb() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        bind: vi.fn((...params: unknown[]) => {
          queries.push({ sql, params });
          return stmt;
        }),
        run: vi.fn().mockResolvedValue({}),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
      };
      return stmt;
    }),
  } as unknown as D1Database;
  return { db, queries };
}

function makeExecutionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEntryRouteByRefCode).mockResolvedValue(null);
});

describe('POST /webhook — follow イベントでの副業マッチングトリガー', () => {
  async function follow(refCode: string | null, isJobMatching: boolean) {
    jobMatchingMocks.isJobMatchingReferral.mockReturnValue(isJobMatching);
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-follow',
      displayName: 'New Friend',
      pictureUrl: null,
      statusMessage: null,
    });
    // friends.ref_code (first-touch, written once by /auth/callback) を
    // 最初から埋めておくことで、webhook.ts 側のリトライループ
    // (getFriendById を最大5回・200ms間隔で呼ぶ) を回避し、テストを高速に保つ。
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-follow',
      display_name: 'New Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      ref_code: refCode,
      created_at: '2026-08-21T21:00:00.000+09:00',
      updated_at: '2026-08-21T21:00:00.000+09:00',
    } as unknown as Awaited<ReturnType<typeof upsertFriend>>);

    const { db } = recordingDb();
    const executionCtx = makeExecutionCtx();

    const res = await setupApp().request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'follow',
              replyToken: 'reply-token',
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-follow' },
              webhookEventId: 'event-follow',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing.catch(() => {});
  }

  test('jobmatch- な ref_code の友だち追加では beginJobMatchingConversation を呼ぶ', async () => {
    await follow('jobmatch-x-post', true);

    expect(jobMatchingMocks.isJobMatchingReferral).toHaveBeenCalledWith('jobmatch-x-post');
    expect(jobMatchingMocks.beginJobMatchingConversation).toHaveBeenCalledTimes(1);
    const [, , friendArg] = jobMatchingMocks.beginJobMatchingConversation.mock.calls[0];
    expect(friendArg.id).toBe('friend-1');
  });

  test('通常の ref_code の友だち追加では beginJobMatchingConversation を呼ばない', async () => {
    await follow('regular-campaign', false);

    expect(jobMatchingMocks.beginJobMatchingConversation).not.toHaveBeenCalled();
  });

  test('ref_code が無い友だち追加でも beginJobMatchingConversation を呼ばない', async () => {
    await follow(null, false);

    expect(jobMatchingMocks.beginJobMatchingConversation).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — postback イベントでの副業マッチング優先処理', () => {
  async function postback(data: string, envOverride: Partial<Env['Bindings']> = {}) {
    const { db } = recordingDb();
    const executionCtx = makeExecutionCtx();

    const res = await setupApp().request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'postback',
              replyToken: 'reply-token-postback',
              postback: { data },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-postback-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db, ...envOverride },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing.catch(() => {});
  }

  test('handled:true のとき、通常の auto-reply マッチングを呼ばず postback_received を matched:true で発火する', async () => {
    jobMatchingMocks.handleJobMatchingPostback.mockResolvedValue({ handled: true });

    await postback('jobmatch_q1:fulltime');

    expect(jobMatchingMocks.handleJobMatchingPostback).toHaveBeenCalledTimes(1);
    expect(autoReplyMocks.matchAndReply).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledWith(
      expect.anything(),
      'postback_received',
      expect.objectContaining({
        friendId: 'friend-1',
        eventData: { text: 'jobmatch_q1:fulltime', matched: true },
        replyToken: 'reply-token-postback',
      }),
      'env-default-token',
      null,
    );
  });

  test('handled:false のときは通常の auto-reply マッチングにフォールバックする', async () => {
    jobMatchingMocks.handleJobMatchingPostback.mockResolvedValue({ handled: false });

    await postback('tag:premium');

    expect(jobMatchingMocks.handleJobMatchingPostback).toHaveBeenCalledTimes(1);
    expect(autoReplyMocks.matchAndReply).toHaveBeenCalledTimes(1);
  });

  test('job-matching の処理が例外を投げても、通常の auto-reply フローは継続する', async () => {
    jobMatchingMocks.handleJobMatchingPostback.mockRejectedValue(new Error('boom'));

    await postback('tag:premium');

    expect(autoReplyMocks.matchAndReply).toHaveBeenCalledTimes(1);
  });

  test('AI_REPLY_ENABLED=true かつ ANTHROPIC_API_KEY 設定時は buildProvider() を呼び、その結果を渡す', async () => {
    jobMatchingMocks.handleJobMatchingPostback.mockResolvedValue({ handled: true });
    const fakeProvider = { generateReply: vi.fn() };
    aiReplyMocks.buildProvider.mockReturnValue(fakeProvider);

    await postback('jobmatch_q2:high_value', { AI_REPLY_ENABLED: 'true', ANTHROPIC_API_KEY: 'key' });

    expect(aiReplyMocks.buildProvider).toHaveBeenCalledTimes(1);
    const [, , , , aiProviderArg] = jobMatchingMocks.handleJobMatchingPostback.mock.calls[0];
    expect(aiProviderArg).toBe(fakeProvider);
  });

  test('AI_REPLY_ENABLED が未設定/false のときは buildProvider() を呼ばず null を渡す (マスタースイッチのバイパス防止)', async () => {
    jobMatchingMocks.handleJobMatchingPostback.mockResolvedValue({ handled: true });

    await postback('jobmatch_q2:high_value', { ANTHROPIC_API_KEY: 'key' });

    expect(aiReplyMocks.buildProvider).not.toHaveBeenCalled();
    const [, , , , aiProviderArg] = jobMatchingMocks.handleJobMatchingPostback.mock.calls[0];
    expect(aiProviderArg).toBeNull();
  });

  test('AI_REPLY_ENABLED=false のときも buildProvider() を呼ばない', async () => {
    jobMatchingMocks.handleJobMatchingPostback.mockResolvedValue({ handled: true });

    await postback('jobmatch_q2:high_value', { AI_REPLY_ENABLED: 'false', ANTHROPIC_API_KEY: 'key' });

    expect(aiReplyMocks.buildProvider).not.toHaveBeenCalled();
  });
});
