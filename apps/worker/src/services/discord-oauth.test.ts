import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discordOAuthConfigured, buildDiscordAuthorizeUrl, exchangeDiscordCode } from './discord-oauth.js';

const CREDS = {
  clientId: 'client-123',
  clientSecret: 'secret-abc',
  redirectUri: 'https://line-harness.example/discord/callback',
};

describe('discordOAuthConfigured', () => {
  it('3つとも揃っていれば true', () => {
    expect(discordOAuthConfigured(CREDS)).toBe(true);
  });

  it('1つでも欠けていれば false', () => {
    expect(discordOAuthConfigured({ ...CREDS, clientSecret: undefined })).toBe(false);
    expect(discordOAuthConfigured({})).toBe(false);
  });
});

describe('buildDiscordAuthorizeUrl', () => {
  it('client_id・redirect_uri・scope=identify・state を含むURLを組み立てる', () => {
    const url = buildDiscordAuthorizeUrl(CREDS, 'token-xyz');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://discord.com/api/oauth2/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe(CREDS.redirectUri);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('identify');
    expect(parsed.searchParams.get('state')).toBe('token-xyz');
  });
});

describe('exchangeDiscordCode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('コードをトークンに交換し、ユーザー情報を取得して返す', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'discord-user-1', username: 'taro' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const user = await exchangeDiscordCode(CREDS, 'auth-code-1');

    expect(user).toEqual({ id: 'discord-user-1', username: 'taro' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://discord.com/api/oauth2/token');
    expect(String(tokenInit.body)).toContain('grant_type=authorization_code');
    expect(String(tokenInit.body)).toContain('code=auth-code-1');
    const [userUrl, userInit] = fetchMock.mock.calls[1];
    expect(userUrl).toBe('https://discord.com/api/users/@me');
    expect(userInit.headers.authorization).toBe('Bearer tok-1');
  });

  it('トークン交換が失敗したら例外を投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('invalid_grant', { status: 400 })));

    await expect(exchangeDiscordCode(CREDS, 'bad-code')).rejects.toThrow('discord_token_exchange_failed');
  });

  it('ユーザー情報取得が失敗したら例外を投げる', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeDiscordCode(CREDS, 'auth-code-1')).rejects.toThrow('discord_user_fetch_failed');
  });
});
