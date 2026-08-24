import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const sharedMocks = vi.hoisted(() => ({ guideToMarkdown: vi.fn(() => '# 使い方\n- ダッシュボード — 概要') }));
vi.mock('@line-crm/shared', () => sharedMocks);

const dbMocks = vi.hoisted(() => ({ getLineAccountById: vi.fn(async () => ({ id: 'acc1', name: 'メイン店' })) }));
vi.mock('@line-crm/db', () => dbMocks);

const advisorMocks = vi.hoisted(() => ({
  buildOperationsSnapshot: vi.fn(async (_db: unknown, _opts?: { lineAccountId?: string; accountName?: string }) => '## 未対応\n- 3件'),
}));
vi.mock('../services/advisor.js', () => advisorMocks);

type GenReq = { systemPrompt: string; history: { role: string; content: string }[] };
const aiMocks = vi.hoisted(() => ({
  generateReply: vi.fn(async (_req: { systemPrompt: string; history: { role: string; content: string }[] }) => 'AIの回答です'),
  buildProvider: vi.fn(),
}));
vi.mock('../services/ai-reply/index.js', () => ({ buildProvider: aiMocks.buildProvider }));

import { assistant } from './assistant.js';

function app() {
  const a = new Hono<Env>();
  a.route('/', assistant);
  return (body: unknown) =>
    a.request('/api/assistant/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { DB: {} as D1Database, ANTHROPIC_API_KEY: 'k' } as unknown as Env['Bindings']);
}

beforeEach(() => {
  vi.clearAllMocks();
  aiMocks.buildProvider.mockReturnValue({ generateReply: aiMocks.generateReply });
});

describe('POST /api/assistant/ask', () => {
  it('returns the AI answer for a question', async () => {
    const res = await app()({ question: '今の状況をまとめて' });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { answer: string } };
    expect(body.success).toBe(true);
    expect(body.data.answer).toBe('AIの回答です');
    expect(advisorMocks.buildOperationsSnapshot).toHaveBeenCalled();
  });

  it('assembles systemPrompt with guide + snapshot and puts question as last user turn', async () => {
    await app()({
      question: '未対応を減らすには?',
      history: [
        { role: 'user', content: '前の質問' },
        { role: 'assistant', content: '前の回答' },
        { role: 'system', content: 'これは無視される' }, // 不正roleは除去
      ],
    });
    const arg = aiMocks.generateReply.mock.calls[0][0] as GenReq;
    expect(arg.systemPrompt).toContain('ダッシュボード — 概要'); // guide
    expect(arg.systemPrompt).toContain('未対応'); // snapshot
    expect(arg.systemPrompt).toContain('画面リンク一覧'); // 画面リンク
    expect(arg.systemPrompt).toContain('/notifications'); // リンクのパス
    // history: sanitize で system は除去、question が末尾
    expect(arg.history.map((h) => h.role)).toEqual(['user', 'assistant', 'user']);
    expect(arg.history[arg.history.length - 1]).toEqual({ role: 'user', content: '未対応を減らすには?' });
  });

  it('accountId を渡すとアカウント別集計になり、対象アカウント名が systemPrompt に入る', async () => {
    await app()({ question: '今の状況は?', accountId: 'acc1' });
    // buildOperationsSnapshot に lineAccountId が渡る
    expect(advisorMocks.buildOperationsSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc1', accountName: 'メイン店' }),
    );
    const arg = aiMocks.generateReply.mock.calls[0][0] as GenReq;
    expect(arg.systemPrompt).toContain('分析対象アカウント: メイン店');
  });

  it('accountId 未指定なら全体集計 (lineAccountId は undefined)', async () => {
    await app()({ question: '今の状況は?' });
    expect(advisorMocks.buildOperationsSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: undefined }),
    );
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
  });

  it('400 when ANTHROPIC key is not configured (no provider)', async () => {
    aiMocks.buildProvider.mockReturnValue(null);
    const res = await app()({ question: 'テスト' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/AIが未設定/);
  });

  it('400 when question is empty', async () => {
    const res = await app()({ question: '   ' });
    expect(res.status).toBe(400);
    expect(aiMocks.generateReply).not.toHaveBeenCalled();
  });

  it('500 when generation throws', async () => {
    aiMocks.generateReply.mockRejectedValueOnce(new Error('boom'));
    const res = await app()({ question: 'テスト' });
    expect(res.status).toBe(500);
  });
});
