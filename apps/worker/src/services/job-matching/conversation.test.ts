import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getJobMatchingLeadState: vi.fn(),
  startJobMatchingConversation: vi.fn(),
  recordQ1Answer: vi.fn(),
  recordQ2AnswerAndScore: vi.fn(),
}));
vi.mock('@line-crm/db', () => dbMocks);

const eventBusMocks = vi.hoisted(() => ({
  logOutgoingMessage: vi.fn(),
}));
vi.mock('../event-bus.js', () => eventBusMocks);

const discordMocks = vi.hoisted(() => ({
  notifyDiscordOfLead: vi.fn(),
}));
vi.mock('./discord-notify.js', () => discordMocks);

import {
  isJobMatchingReferral,
  beginJobMatchingConversation,
  handleJobMatchingPostback,
  JOB_MATCHING_REF_PREFIX,
} from './conversation.js';
import type { Friend } from '@line-crm/db';

const FRIEND: Friend = {
  id: 'friend-1',
  line_user_id: 'U123',
  display_name: 'テスト太郎',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: null,
  line_account_id: null,
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-08-19T00:00:00.000+09:00',
  updated_at: '2026-08-19T00:00:00.000+09:00',
} as Friend;

function fakeDb(): D1Database {
  return {} as unknown as D1Database;
}

function fakeLineClient() {
  return { pushMessage: vi.fn() } as unknown as import('@line-crm/line-sdk').LineClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isJobMatchingReferral', () => {
  it(`${JOB_MATCHING_REF_PREFIX} で始まる ref_code は true`, () => {
    expect(isJobMatchingReferral('jobmatch-x-post')).toBe(true);
  });

  it('プレフィックスが一致しない ref_code は false', () => {
    expect(isJobMatchingReferral('x-post-campaign')).toBe(false);
  });

  it('null / undefined は false', () => {
    expect(isJobMatchingReferral(null)).toBe(false);
    expect(isJobMatchingReferral(undefined)).toBe(false);
  });
});

describe('beginJobMatchingConversation', () => {
  it('会話状態を開始し、Q1 クイックリプライ付きメッセージを push する', async () => {
    const db = fakeDb();
    const lineClient = fakeLineClient();

    await beginJobMatchingConversation(db, lineClient, FRIEND);

    expect(dbMocks.startJobMatchingConversation).toHaveBeenCalledWith(db, FRIEND.id);
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    const [userId, messages] = (lineClient.pushMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userId).toBe(FRIEND.line_user_id);
    expect(messages[0].quickReply.items.length).toBeGreaterThan(0);
    expect(eventBusMocks.logOutgoingMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ friendId: FRIEND.id, source: 'job_matching', deliveryType: 'push' }),
    );
  });

  it('禁止語（期限煽り・断定表現）を含まない', async () => {
    const db = fakeDb();
    const lineClient = fakeLineClient();

    await beginJobMatchingConversation(db, lineClient, FRIEND);

    const [, messages] = (lineClient.pushMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = messages[0].text as string;
    for (const banned of ['本日限り', '枠が埋まり次第', '絶対', '必ず稼げ']) {
      expect(text).not.toContain(banned);
    }
  });
});

describe('handleJobMatchingPostback', () => {
  it('awaiting_q1 中に Q1 postback を受けると回答を記録し Q2 を送る', async () => {
    dbMocks.getJobMatchingLeadState.mockResolvedValue({
      job_matching_conversation_state: 'awaiting_q1',
      q1_answer: null,
      q2_answer: null,
      lead_score: null,
      lead_temperature: null,
    });
    const db = fakeDb();
    const lineClient = fakeLineClient();

    const result = await handleJobMatchingPostback(
      db,
      lineClient,
      FRIEND,
      'jobmatch_q1:fulltime',
      null,
      {},
    );

    expect(result.handled).toBe(true);
    expect(dbMocks.recordQ1Answer).toHaveBeenCalledWith(db, FRIEND.id, 'fulltime');
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(discordMocks.notifyDiscordOfLead).not.toHaveBeenCalled();
  });

  it('状態が awaiting_q1 でないときは Q1 postback を無視する (handled:false)', async () => {
    dbMocks.getJobMatchingLeadState.mockResolvedValue({
      job_matching_conversation_state: 'diagnosed',
      q1_answer: 'fulltime',
      q2_answer: 'high_value',
      lead_score: 70,
      lead_temperature: 'hot',
    });
    const db = fakeDb();
    const lineClient = fakeLineClient();

    const result = await handleJobMatchingPostback(db, lineClient, FRIEND, 'jobmatch_q1:fulltime', null, {});

    expect(result.handled).toBe(false);
    expect(dbMocks.recordQ1Answer).not.toHaveBeenCalled();
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('awaiting_q2 中に Q2 postback を受けるとスコアリング・診断メッセージ送信・Discord通知まで行う', async () => {
    dbMocks.getJobMatchingLeadState.mockResolvedValue({
      job_matching_conversation_state: 'awaiting_q2',
      q1_answer: 'fulltime',
      q2_answer: null,
      lead_score: null,
      lead_temperature: null,
    });
    const db = fakeDb();
    const lineClient = fakeLineClient();
    const env = { DISCORD_LEADS_WEBHOOK_URL: 'https://discord.example/webhook' };

    const result = await handleJobMatchingPostback(
      db,
      lineClient,
      FRIEND,
      'jobmatch_q2:high_value',
      null,
      env,
    );

    expect(result.handled).toBe(true);
    // fulltime(40) + high_value(30) = 70 → hot
    expect(dbMocks.recordQ2AnswerAndScore).toHaveBeenCalledWith(db, FRIEND.id, 'high_value', 70, 'hot');
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(discordMocks.notifyDiscordOfLead).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ score: 70, temperature: 'hot' }),
    );
  });

  it('AI プロバイダが例外を投げてもフォールバック文言で送信を継続する', async () => {
    dbMocks.getJobMatchingLeadState.mockResolvedValue({
      job_matching_conversation_state: 'awaiting_q2',
      q1_answer: 'gap_time',
      q2_answer: null,
      lead_score: null,
      lead_temperature: null,
    });
    const db = fakeDb();
    const lineClient = fakeLineClient();
    const aiProvider = { generateReply: vi.fn().mockRejectedValue(new Error('timeout')) };

    const result = await handleJobMatchingPostback(
      db,
      lineClient,
      FRIEND,
      'jobmatch_q2:other',
      aiProvider as unknown as import('../ai-reply/index.js').AiReplyProvider,
      {},
    );

    expect(result.handled).toBe(true);
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    const [, messages] = (lineClient.pushMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].text).toContain('診断結果');
  });

  it('未知の postback data は handled:false を返す', async () => {
    const db = fakeDb();
    const lineClient = fakeLineClient();

    const result = await handleJobMatchingPostback(db, lineClient, FRIEND, 'unrelated_menu_tap', null, {});

    expect(result.handled).toBe(false);
    expect(dbMocks.getJobMatchingLeadState).not.toHaveBeenCalled();
  });
});
