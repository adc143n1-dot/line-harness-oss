// LINE↔Discord 紐付け (副業マッチング Phase C) の OAuth2 部分。
//
// Discord のBot Gateway (WebSocket常時接続) はステートレスなCloudflare Workers
// と相性が悪いため、Telegram Bot APIのようなWebhook方式は使わない。代わりに
// 標準のOAuth2認可コードフロー (ブラウザリダイレクト→コード交換) を使う —
// これは既存の LINE Login / Google OAuth と同じ形で Workers 上で完結する。

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

export interface DiscordOAuthCredentials {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface DiscordUser {
  id: string;
  username: string;
}

export function discordOAuthConfigured(creds: DiscordOAuthCredentials): boolean {
  return Boolean(creds.clientId?.trim() && creds.clientSecret?.trim() && creds.redirectUri?.trim());
}

/** 認可画面のURL。state には discord_invite_tokens.token をそのまま使う。 */
export function buildDiscordAuthorizeUrl(creds: DiscordOAuthCredentials, state: string): string {
  const params = new URLSearchParams({
    client_id: creds.clientId!,
    redirect_uri: creds.redirectUri!,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
}

/** 認可コードをアクセストークンに交換し、続けて Discord ユーザー情報を取得する。 */
export async function exchangeDiscordCode(
  creds: DiscordOAuthCredentials,
  code: string,
): Promise<DiscordUser> {
  const tokenRes = await fetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId!,
      client_secret: creds.clientSecret!,
      grant_type: 'authorization_code',
      code,
      redirect_uri: creds.redirectUri!,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`discord_token_exchange_failed: ${tokenRes.status} ${await tokenRes.text().catch(() => '')}`);
  }
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  if (!tokenBody.access_token) throw new Error('discord_token_exchange_missing_access_token');

  const userRes = await fetch(DISCORD_USER_URL, {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`discord_user_fetch_failed: ${userRes.status} ${await userRes.text().catch(() => '')}`);
  }
  const user = (await userRes.json()) as { id?: string; username?: string };
  if (!user.id) throw new Error('discord_user_fetch_missing_id');

  return { id: user.id, username: user.username ?? '' };
}
