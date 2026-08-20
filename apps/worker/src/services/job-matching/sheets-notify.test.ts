import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifySheetsOfLead } from './sheets-notify.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
});

const LEAD = {
  friendId: 'friend-1',
  friendName: 'テスト太郎',
  q1Label: '本業レベルでしっかり稼ぎたい',
  q2Label: '高額案件',
  score: 70,
  temperature: 'hot' as const,
  occurredAt: '2026-08-20T10:00:00.000+09:00',
};

describe('notifySheetsOfLead', () => {
  it('GOOGLE_SHEETS_WEBHOOK_URL 未設定なら何も送信しない', async () => {
    await notifySheetsOfLead({}, LEAD);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('GASのWeb App URLへ、行データに必要な全フィールドをJSONでPOSTする', async () => {
    await notifySheetsOfLead({ GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/xxx/exec' }, LEAD);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://script.google.com/macros/s/xxx/exec');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      friendId: 'friend-1',
      friendName: 'テスト太郎',
      q1Label: '本業レベルでしっかり稼ぎたい',
      q2Label: '高額案件',
      score: 70,
      temperature: 'hot',
      occurredAt: '2026-08-20T10:00:00.000+09:00',
    });
  });

  it('fetch が失敗しても例外を投げない (リード登録処理を止めない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await expect(
      notifySheetsOfLead({ GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/xxx/exec' }, LEAD),
    ).resolves.toBeUndefined();
  });

  it('GAS側が非2xxを返しても例外を投げない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error', { status: 500 })));

    await expect(
      notifySheetsOfLead({ GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/xxx/exec' }, LEAD),
    ).resolves.toBeUndefined();
  });
});
