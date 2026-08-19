import { describe, expect, test, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({
  getAccountSetting: vi.fn(),
  setAccountSetting: vi.fn(),
}));
vi.mock('./unanswered-inbox.js', () => ({ countUnanswered: vi.fn() }));
vi.mock('./event-bus.js', () => ({ fireEvent: vi.fn() }));

import { getAccountSetting, setAccountSetting } from '@line-crm/db';
import { countUnanswered } from './unanswered-inbox.js';
import { fireEvent } from './event-bus.js';
import { checkUnansweredBacklogSpike } from './anomaly-monitor.js';

const fakeDb = {} as unknown as D1Database;

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
