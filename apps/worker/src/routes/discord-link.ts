import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import { discordOAuthConfigured, exchangeDiscordCode } from '../services/discord-oauth.js';
import { pageShell } from '../lib/page-shell.js';

const discordLink = new Hono<Env>();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function simplePage(title: string, heading: string, message: string, ok: boolean): string {
  return pageShell({
    title: escapeHtml(title),
    extraCss: `.title{color:${ok ? '#5865F2' : '#e53e3e'}}
.msg{margin-bottom:0}`,
    body: `<div class="card">
<p class="title">${escapeHtml(heading)}</p>
<p class="msg">${escapeHtml(message)}</p>
</div>`,
  });
}

/**
 * Discord OAuth2 の認可コードフローのコールバック先。
 * state には invite-discord (chats.ts) が発行した discord_invite_tokens.token を
 * そのまま渡している — 署名付きの別state方式は使わず、DB上のワンタイムトークン
 * 自体をそのまま state として使い回すことで、Telegram連携と同じシンプルな
 * atomic-claim パターンを踏襲する。
 */
discordLink.get('/discord/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    return c.html(simplePage('連携キャンセル', '連携がキャンセルされました', '再度お試しになる場合は、担当スタッフにリンクの再発行をご依頼ください。', false));
  }

  const code = c.req.query('code');
  const token = c.req.query('state');
  if (!code || !token) {
    return c.html(simplePage('エラー', 'リクエストが不正です', 'パラメータが不足しています。担当スタッフにご連絡ください。', false));
  }

  const creds = {
    clientId: c.env.DISCORD_OAUTH_CLIENT_ID,
    clientSecret: c.env.DISCORD_OAUTH_CLIENT_SECRET,
    redirectUri: `${c.env.WORKER_URL || new URL(c.req.url).origin}/discord/callback`,
  };
  if (!discordOAuthConfigured(creds)) {
    console.error('[discord-link] Discord OAuth is not configured');
    return c.html(simplePage('エラー', '設定エラー', 'しばらくしてから再度お試しください。担当スタッフにご連絡ください。', false));
  }

  const now = jstNow();

  // 使用済みマークを先に、条件付き UPDATE で原子的に行う (telegram.ts と同じ理由:
  // SELECT してから UPDATE すると二重タップで両方有効と判定されうる)。
  const claim = await c.env.DB
    .prepare(
      `UPDATE discord_invite_tokens SET used_at = ?
        WHERE token = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(now, token, now)
    .run();

  if (!claim.meta.changes) {
    return c.html(simplePage('エラー', 'リンクが無効です', 'このリンクは無効か、期限切れ、またはすでに使用済みです。担当スタッフに再発行を依頼してください。', false));
  }

  const row = await c.env.DB
    .prepare(`SELECT friend_id FROM discord_invite_tokens WHERE token = ?`)
    .bind(token)
    .first<{ friend_id: string }>();

  if (!row) {
    return c.html(simplePage('エラー', 'リンクが無効です', '担当スタッフにご連絡ください。', false));
  }

  let discordUser;
  try {
    discordUser = await exchangeDiscordCode(creds, code);
  } catch (err) {
    console.error('[discord-link] code exchange failed:', err);
    return c.html(simplePage('エラー', '連携に失敗しました', 'Discordとの通信に失敗しました。担当スタッフにご連絡ください。', false));
  }

  try {
    await c.env.DB
      .prepare(`UPDATE friends SET discord_user_id = ?, discord_verified_at = ? WHERE id = ?`)
      .bind(discordUser.id, now, row.friend_id)
      .run();
  } catch (err) {
    // friends.discord_user_id は部分 UNIQUE。既に別の友だちに紐付いている
    // Discord アカウントで開かれた場合はここに来る。トークンは使用済みのままにする。
    console.error('[discord-link] link failed:', err);
    return c.html(simplePage('エラー', '連携できませんでした', 'この Discord アカウントは既に別の方と連携済みです。担当スタッフにご連絡ください。', false));
  }

  return c.html(simplePage('連携完了', '✅ 連携が完了しました', 'このページは閉じていただいて構いません。担当スタッフからご案内します。', true));
});

export { discordLink };
