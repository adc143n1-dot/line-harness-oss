import { describe, expect, test, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({
  getAccountSetting: vi.fn(),
  setAccountSetting: vi.fn(),
}));
vi.mock('./unanswered-inbox.js', () => ({ countUnanswered: vi.fn(), getAllUnansweredRows: vi.fn() }));
vi.mock('./event-bus.js', () => ({ fireEvent: vi.fn() }));

import { getAccountSetting, setAccountSetting } from '@line-crm/db';
import { countUnanswered, getAllUnansweredRows } from './unanswered-inbox.js';
import { fireEvent } from './event-bus.js';
import {
  checkUnansweredBacklogSpike,
  checkUnassignedBacklog,
  checkHotLeadsUnassigned,
} from './anomaly-monitor.js';

const fakeDb = {} as unknown as D1Database;

function unansweredRow(operatorId: string | null, lastIncomingAt = '2026-08-22T10:00:00.000+09:00') {
  return {
    friendId: `f-${Math.random()}`, displayName: null, pictureUrl: null,
    accountId: 'a', accountName: 'A', operatorId,
    lastIncomingAt, lastManualAt: null, lastMachineAt: null,
    lastIncomingType: 'text', lastIncomingContent: 'hi',
  };
}

describe('checkUnansweredBacklogSpike', () => {
  test('初回計測 (前回値なし) はベースラインを記録するだけでアラートは出さない', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue(null);
    vi.mocked(countUnanswered).mockResolvedValue({ total: 50, byAccount: [], oldestWaitMinutes: 30 });
    vi.mocked(fireEvent).mockClear();
    vi.mocked(setAccountSetting).mockClear();

    await checkUnansweredBacklogSpike(fakeDb);

    expect(fireEvent).not.toHaveBeenCalled();
    expect(setAccountSetting).toHaveBeenCalledWith(
      fakeDb, '__global__', 'anomaly_unanswered_backlog_prev_count', '50',
    );
  });

  test('増加が既定閾値 (20) 未満なら発火しない', async () => {
    vi.mocked(getAccountSetting).mockImplementation(async (_db, _scope, key) =>
      key === 'anomaly_unanswered_backlog_prev_count' ? '50' : null,
    );
    vi.mocked(countUnanswered).mockResolvedValue({ total: 65, byAccount: [], oldestWaitMinutes: 30 }); // +15
    vi.mocked(fireEvent).mockClear();

    await checkUnansweredBacklogSpike(fakeDb);

    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('増加が既定閾値 (20) 以上なら発火する', async () => {
    vi.mocked(getAccountSetting).mockImplementation(async (_db, _scope, key) =>
      key === 'anomaly_unanswered_backlog_prev_count' ? '50' : null,
    );
    vi.mocked(countUnanswered).mockResolvedValue({ total: 80, byAccount: [], oldestWaitMinutes: 45 }); // +30
    vi.mocked(fireEvent).mockClear();

    await checkUnansweredBacklogSpike(fakeDb);

    expect(fireEvent).toHaveBeenCalledTimes(1);
    const [, eventType, payload] = vi.mocked(fireEvent).mock.calls[0];
    expect(eventType).toBe('unanswered_backlog_spike');
    expect(payload).toMatchObject({
      eventData: { previousTotal: 50, currentTotal: 80, delta: 30, threshold: 20, oldestWaitMinutes: 45 },
    });
  });

  test('カスタム閾値が設定されていればそちらを使う', async () => {
    vi.mocked(getAccountSetting).mockImplementation(async (_db, _scope, key) => {
      if (key === 'anomaly_unanswered_backlog_prev_count') return '100';
      if (key === 'anomaly_unanswered_spike_threshold') return '5';
      return null;
    });
    vi.mocked(countUnanswered).mockResolvedValue({ total: 107, byAccount: [], oldestWaitMinutes: 10 }); // +7
    vi.mocked(fireEvent).mockClear();

    await checkUnansweredBacklogSpike(fakeDb);

    // 既定 20 なら発火しないはずの増加幅 (+7) だが、閾値 5 では発火する
    expect(fireEvent).toHaveBeenCalledTimes(1);
  });

  test('悪化が続く限り、抑制せず毎回発火する (クールダウンを意図的に入れない)', async () => {
    vi.mocked(getAccountSetting).mockImplementation(async (_db, _scope, key) =>
      key === 'anomaly_unanswered_backlog_prev_count' ? '50' : null,
    );
    vi.mocked(countUnanswered).mockResolvedValue({ total: 90, byAccount: [], oldestWaitMinutes: 60 });
    vi.mocked(fireEvent).mockClear();

    await checkUnansweredBacklogSpike(fakeDb);
    await checkUnansweredBacklogSpike(fakeDb);

    expect(fireEvent).toHaveBeenCalledTimes(2);
  });
});

describe('checkUnassignedBacklog — 未割当バックログの絶対量アラート', () => {
  test('未割当が既定閾値 (10) 未満なら発火しない (担当済みの未対応はカウントしない)', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue(null);
    vi.mocked(getAllUnansweredRows).mockResolvedValue([
      ...Array.from({ length: 9 }, () => unansweredRow(null)),
      ...Array.from({ length: 20 }, () => unansweredRow('staff-a')), // 担当済みは無関係
    ]);
    vi.mocked(fireEvent).mockClear();

    await checkUnassignedBacklog(fakeDb);

    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('未割当が既定閾値以上なら team_unassigned_backlog を発火し、最古の受信時刻を含める', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue(null);
    vi.mocked(getAllUnansweredRows).mockResolvedValue([
      unansweredRow(null, '2026-08-22T09:00:00.000+09:00'),
      ...Array.from({ length: 9 }, () => unansweredRow(null, '2026-08-22T11:00:00.000+09:00')),
    ]);
    vi.mocked(fireEvent).mockClear();

    await checkUnassignedBacklog(fakeDb);

    expect(fireEvent).toHaveBeenCalledTimes(1);
    const [, eventType, payload] = vi.mocked(fireEvent).mock.calls[0];
    expect(eventType).toBe('team_unassigned_backlog');
    expect(payload).toMatchObject({
      eventData: {
        unassignedCount: 10,
        threshold: 10,
        oldestIncomingAt: '2026-08-22T09:00:00.000+09:00',
      },
    });
  });

  test('カスタム閾値 (account_settings) を尊重する', async () => {
    vi.mocked(getAccountSetting).mockImplementation(async (_db, _scope, key) =>
      key === 'team_unassigned_alert_threshold' ? '3' : null,
    );
    vi.mocked(getAllUnansweredRows).mockResolvedValue([
      unansweredRow(null), unansweredRow(null), unansweredRow(null),
    ]);
    vi.mocked(fireEvent).mockClear();

    await checkUnassignedBacklog(fakeDb);

    expect(fireEvent).toHaveBeenCalledTimes(1);
  });
});

describe('checkHotLeadsUnassigned — HOTリード未割当アラート', () => {
  function dbWithHotCount(cnt: number) {
    return {
      prepare: () => ({
        bind: function () { return this; },
        first: async () => ({ cnt }),
      }),
    } as unknown as D1Database;
  }

  test('HOT未割当が0件なら発火しない', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue(null);
    vi.mocked(fireEvent).mockClear();

    await checkHotLeadsUnassigned(dbWithHotCount(0));

    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('既定では1件でも発火する (HOTは即日対応前提)', async () => {
    vi.mocked(getAccountSetting).mockResolvedValue(null);
    vi.mocked(fireEvent).mockClear();

    await checkHotLeadsUnassigned(dbWithHotCount(1));

    expect(fireEvent).toHaveBeenCalledTimes(1);
    const [, eventType, payload] = vi.mocked(fireEvent).mock.calls[0];
    expect(eventType).toBe('team_hot_leads_unassigned');
    expect(payload).toMatchObject({ eventData: { hotUnassignedCount: 1, threshold: 1 } });
  });
});
