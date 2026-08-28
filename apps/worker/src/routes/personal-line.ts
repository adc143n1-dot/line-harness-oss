import { Hono } from 'hono';
import {
  jstNow,
  getPersonalLineAccountById,
  upsertPersonalLineFriend,
  upsertChatOnMessage,
  getChatByFriendId,
} from '@line-crm/db';
import type { Friend, AutoReply, PersonalLineAccount } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { keywordMatches } from '../services/auto-reply.js';
import { maybeSendAiReply } from '../services/ai-reply/index.js';
import { deliverToFriend } from '../services/messaging/dispatch.js';
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

// 個人LINE(非公式ブリッジ経由)の受信 webhook。
// 個人LINEには公式APIが無いため、外部ブリッジ(非公式クライアント常駐サーバー)が
// LINE から受けたメッセージを、このエンドポイントへ中継してくる。
// 認証は account.inbound_secret を X-Bridge-Secret ヘッダで照合 (fail-closed)。
// Telegram(telegram.ts) と同じ受信フロー: friend upsert → messages_log →
// chat化 → イベント発火 → テキスト自動化(自動返信+AI応答)。

/** ブリッジへ生テキスト送信 (messages_log は残さない。AI応答シム用)。 */
async function bridgeSendRaw(account: PersonalLineAccount, to: string, text: string): Promise<void> {
  const base = (account.bridge_base_url ?? '').replace(/\/$/, '');
  if (!base) return;
  try {
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.bridge_secret}` },
      body: JSON.stringify({ to, type: 'text', content: text }),
    });
    if (!res.ok) {
      console.error('[personal-line] bridge raw send failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.error('[personal-line] bridge raw send error:', err);
  }
}

/**
 * 個人LINE受信テキストに対する自動化 (自動返信キーワード + AI応答)。
 * telegram.ts の runTelegramTextAutomation と同型。
 */
async function runPersonalLineTextAutomation(
  env: Env['Bindings'],
  friend: Friend,
  account: PersonalLineAccount,
  incomingText: string,
): Promise<void> {
  // 1) キーワード自動返信 (グローバルルールのみ = line_account_id IS NULL)
  try {
    const rules = await env.DB
      .prepare(
        `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`,
      )
      .all<AutoReply>();
    const rule = rules.results.find((r) => keywordMatches(r, incomingText));
    if (rule && rule.response_type !== 'silent') {
      if (rule.response_type === 'text' && rule.response_content) {
        await deliverToFriend(env, friend, { type: 'text', content: rule.response_content }, { source: 'auto_reply' });
        return; // マッチしたら AI 応答はしない
      }
      // text 以外 (flex等) は個人LINE非対応。AI 応答に委ねる。
    }
  } catch (err) {
    console.error('[personal-line] auto-reply failed:', err);
  }

  // 2) AI 応答 (送信をブリッジに差し替えたシムで既存ロジックを再利用)
  try {
    const chat = await getChatByFriendId(env.DB, friend.id);
    const shim = {
      pushTextMessage: async (_userId: string, text: string) => {
        await bridgeSendRaw(account, friend.personal_line_user_id ?? '', text);
      },
    } as unknown as LineClient;
    await maybeSendAiReply(
      env.DB,
      shim,
      friend,
      { operator_id: chat?.operator_id ?? null },
      incomingText,
      env,
      { lineAccountId: null },
    );
  } catch (err) {
    console.error('[personal-line] ai-reply failed:', err);
  }
}

const personalLine = new Hono<Env>();

type PersonalLineFrom = { userId?: string; displayName?: string | null; pictureUrl?: string | null };
type PersonalLineIncoming = {
  from?: PersonalLineFrom;
  message?: { type?: string; text?: string; imageUrl?: string };
};

// URL: /api/personal-line/webhook/:accountId  (personal_line_accounts.id ごと)
// ブリッジが登録した inbound_secret を X-Bridge-Secret ヘッダで照合する。
personalLine.post('/api/personal-line/webhook/:accountId', async (c) => {
  const accountId = c.req.param('accountId');
  const account = await getPersonalLineAccountById(c.env.DB, accountId);
  // アカウント不明・無効・secret不一致は 401 (ブリッジ側で誤設定に気づけるように)
  if (!account || account.is_active !== 1) {
    return c.json({ success: false, error: 'Unknown or inactive personal LINE account' }, 401);
  }
  if (c.req.header('X-Bridge-Secret') !== account.inbound_secret) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  let update: PersonalLineIncoming;
  try {
    update = await c.req.json<PersonalLineIncoming>();
  } catch {
    return c.json({ ok: true });
  }

  const from = update.from;
  const userId = from?.userId;
  const msg = update.message;
  // 不完全な更新は無視 (200 で再送を止める)
  if (!from || !userId || !msg) {
    return c.json({ ok: true });
  }

  const friend = await upsertPersonalLineFriend(c.env.DB, {
    personalLineAccountId: account.id,
    personalLineUserId: String(userId),
    displayName: from.displayName ?? null,
    pictureUrl: from.pictureUrl ?? null,
  });

  const now = jstNow();
  const logId = crypto.randomUUID();

  // 画像: ブリッジがホストした公開URLを受け取り、既存レンダラ互換の形状で保存。
  if (msg.type === 'image' && msg.imageUrl) {
    const content = JSON.stringify({ originalContentUrl: msg.imageUrl, previewImageUrl: msg.imageUrl });
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, channel, created_at)
         VALUES (?, ?, 'incoming', 'image', ?, 'personal_line', 'personal_line', ?)`,
      )
      .bind(logId, friend.id, content, now)
      .run();
    await upsertChatOnMessage(c.env.DB, friend.id);
    await fireEvent(c.env.DB, 'message_received', { friendId: friend.id });
    return c.json({ ok: true });
  }

  // テキスト。空メッセージはラベル化。
  const text = msg.text ?? '';
  const body = text || '[メッセージ]';
  await c.env.DB
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, channel, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, 'personal_line', 'personal_line', ?)`,
    )
    .bind(logId, friend.id, body, now)
    .run();
  await upsertChatOnMessage(c.env.DB, friend.id);
  await fireEvent(c.env.DB, 'message_received', { friendId: friend.id });
  // 実テキスト受信時のみ自動化 (ラベル化した非テキストでは走らせない)
  if (text) {
    await runPersonalLineTextAutomation(c.env, friend, account, text);
  }
  return c.json({ ok: true });
});

export { personalLine };
