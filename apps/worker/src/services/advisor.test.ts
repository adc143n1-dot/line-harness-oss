import { describe, expect, test, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getAccountSetting: vi.fn(),
  setAccountSetting: vi.fn(),
  jstNow: vi.fn(() => '2026-08-22T15:00:00.000+09:00'),
}));
vi.mock('@line-crm/db', () => dbMocks);

const providerMocks = vi.hoisted(() => ({
  generateReply: vi.fn(async () => '## 🚨 今すぐ直すべきこと\n- テスト所見'),
}));
vi.mock('./ai-reply/index.js', () => ({
  AnthropicProvider: class {
    generateReply = providerMocks.generateReply;
  },
}));

const inboxMocks = vi.hoisted(() => ({
  getAllUnansweredRows: vi.fn(async () => []),
}));
vi.mock('./unanswered-inbox.js', () => inboxMocks);

import {
  runAdvisorAnalysis,
  getLastAdvisorReport,
  maybeRunWeeklyAdvisor,
  buildOperationsSnapshot,
} from './advisor.js';

function fakeDb() {
  return {
    prepare: (sql: string) => ({
      bind: function () { return this; },
      all: async () => {
        if (sql.includes('scenarios_active')) {
          return { results: [{ k: 'scenarios_active', cnt: 2 }, { k: 'auto_replies_active', cnt: 1 }] };
        }
        return { results: [] };
      },
      first: async () => null,
    }),
  } as unknown as D1Database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildOperationsSnapshot', () => {
  test('自動化の稼働状況や未対応件数を含むスナップショットを作る', async () => {
    inboxMocks.getAllUnansweredRows.mockResolvedValue([
      { operatorId: null, lastIncomingAt: '2026-08-22T10:00:00.000+09:00', lastIncomingContent: '料金はいくらですか' },
    ] as never);

    const snapshot = await buildOperationsSnapshot(fakeDb());

    expect(snapshot).toContain('scenarios_active: 2');
    expect(snapshot).toContain('未対応(人間の返事待ち): 1件');
    expect(snapshot).toContain('料金はいくらですか');
  });
});

describe('runAdvisorAnalysis', () => {
  test('APIキー未設定なら例外', async () => {
    await expect(runAdvisorAnalysis(fakeDb(), {}, 'manual')).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  test('分析結果を account_settings に保存して返す', async () => {
    const report = await runAdvisorAnalysis(fakeDb(), { ANTHROPIC_API_KEY: 'key' }, 'manual');

    expect(report.content).toContain('テスト所見');
    expect(report.trigger).toBe('manual');
    expect(dbMocks.setAccountSetting).toHaveBeenCalledWith(
      expect.anything(), '__global__', 'advisor_last_report', expect.stringContaining('テスト所見'),
    );
  });
});

describe('getLastAdvisorReport', () => {
  test('キャッシュが無ければ null', async () => {
    dbMocks.getAccountSetting.mockResolvedValue(null);
    expect(await getLastAdvisorReport(fakeDb())).toBeNull();
  });

  test('保存済みレポートをパースして返す', async () => {
    dbMocks.getAccountSetting.mockResolvedValue(
      JSON.stringify({ generatedAt: '2026-08-22T15:00:00.000+09:00', trigger: 'manual', content: 'x' }),
    );
    const report = await getLastAdvisorReport(fakeDb());
    expect(report?.content).toBe('x');
  });
});

describe('maybeRunWeeklyAdvisor — 明示的オプトイン', () => {
  test('advisor_weekly_enabled が true でなければ何もしない (黙って課金しない)', async () => {
    dbMocks.getAccountSetting.mockResolvedValue(null);

    const result = await maybeRunWeeklyAdvisor(fakeDb(), { ANTHROPIC_API_KEY: 'key' });

    expect(result).toBeNull();
    expect(providerMocks.generateReply).not.toHaveBeenCalled();
  });

  test('有効かつ未実行なら分析して実行時刻を記録する', async () => {
    dbMocks.getAccountSetting.mockImplementation(async (_db, _scope, key) => {
      if (key === 'advisor_weekly_enabled') return 'true';
      return null; // last_weekly_at 無し
    });

    const result = await maybeRunWeeklyAdvisor(fakeDb(), { ANTHROPIC_API_KEY: 'key' });

    expect(result).not.toBeNull();
    expect(dbMocks.setAccountSetting).toHaveBeenCalledWith(
      expect.anything(), '__global__', 'advisor_last_weekly_at', expect.any(String),
    );
  });

  test('6日以内に実行済みならスキップ (多重発火防止)', async () => {
    dbMocks.getAccountSetting.mockImplementation(async (_db, _scope, key) => {
      if (key === 'advisor_weekly_enabled') return 'true';
      if (key === 'advisor_last_weekly_at') return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      return null;
    });

    const result = await maybeRunWeeklyAdvisor(fakeDb(), { ANTHROPIC_API_KEY: 'key' });

    expect(result).toBeNull();
    expect(providerMocks.generateReply).not.toHaveBeenCalled();
  });
});
