import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyDiscordOfLead } from './discord-notify.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
});

describe('notifyDiscordOfLead', () => {
  it('DISCORD_LEADS_WEBHOOK_URL 未設定なら何も送信しない', async () => {
    await notifyDiscordOfLead({}, {
      friendName: 'テスト太郎',
      q1Label: '本業レベルでしっかり稼ぎたい',
      q2Label: '高額案件',
      score: 70,
      temperature: 'hot',
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('Discord Webhook 形式 ({content: string}) で POST する', async () => {
    await notifyDiscordOfLead({ DISCORD_LEADS_WEBHOOK_URL: 'https://discord.example/webhook' }, {
      friendName: 'テスト太郎',
      q1Label: '本業レベルでしっかり稼ぎたい',
      q2Label: '高額案件',
      score: 70,
      temperature: 'hot',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://discord.example/webhook');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body)).toEqual(['content']);
    expect(typeof body.content).toBe('string');
    expect(body.content).toContain('テスト太郎');
    expect(body.content).toContain('70');
  });

  it('fetch が失敗しても例外を投げない (リード登録処理を止めない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await expect(
      notifyDiscordOfLead({ DISCORD_LEADS_WEBHOOK_URL: 'https://discord.example/webhook' }, {
        friendName: 'テスト太郎',
        q1Label: 'すきま時間だけ',
        q2Label: 'その他',
        score: 30,
        temperature: 'cold',
      }),
    ).resolves.toBeUndefined();
  });

  it('Discord 側が非2xxを返しても例外を投げない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));

    await expect(
      notifyDiscordOfLead({ DISCORD_LEADS_WEBHOOK_URL: 'https://discord.example/webhook' }, {
        friendName: 'テスト太郎',
        q1Label: '週に1,2回',
        q2Label: 'SNS運用',
        score: 55,
        temperature: 'warm',
      }),
    ).resolves.toBeUndefined();
  });
});
