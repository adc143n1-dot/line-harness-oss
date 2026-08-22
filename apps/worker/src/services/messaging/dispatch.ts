import { jstNow, getLineAccountById, getTelegramAccountById } from '@line-crm/db';
import type { Friend } from '@line-crm/db';
import { extractFlexAltText } from '../../utils/flex-alt-text.js';
import { TelegramClient } from '../telegram/client.js';
import type { Env } from '../../index.js';

// チャネル横断の送信ディスパッチ。friend.channel で LINE / Telegram を出し分け、
// 送信と messages_log 記録を一元化する。オペレーター送信・自動返信・AI応答が
// これを共有することで、どの経路でも両チャネルに対応できる。

export type OutgoingMessage =
  | { type: 'text'; content: string }
  | { type: 'image'; content: string } // content = JSON {originalContentUrl, previewImageUrl}
  | { type: 'flex'; content: string }; // LINE専用

export interface DeliverOptions {
  /** messages_log.source (manual / auto_reply / ai_reply など) */
  source: string;
  /** 手動送信時のスタッフID (自動送信は null) */
  sentByStaffId?: string | null;
}

export interface DeliverResult {
  ok: boolean;
  error?: string;
  /** 成功時、記録した messages_log の id */
  messageId?: string;
}

function friendChannel(friend: Friend): string {
  return friend.channel ?? 'line';
}

async function sendLine(
  env: Env['Bindings'],
  friend: Friend,
  msg: OutgoingMessage,
): Promise<DeliverResult> {
  // アカウント別アクセストークンを解決 (chats.ts の resolveFriendAndAccessToken と同じ規則)
  let accessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (friend.line_account_id) {
    const account = await getLineAccountById(env.DB, friend.line_account_id);
    if (account) accessToken = account.channel_access_token;
  }
  const { LineClient } = await import('@line-crm/line-sdk');
  const client = new LineClient(accessToken);

  if (msg.type === 'text') {
    await client.pushTextMessage(friend.line_user_id, msg.content);
  } else if (msg.type === 'flex') {
    const contents = JSON.parse(msg.content);
    await client.pushFlexMessage(friend.line_user_id, extractFlexAltText(contents), contents);
  } else {
    const parsed = JSON.parse(msg.content) as { originalContentUrl: string; previewImageUrl: string };
    await client.pushImageMessage(friend.line_user_id, parsed.originalContentUrl, parsed.previewImageUrl);
  }
  return { ok: true };
}

async function sendTelegram(
  env: Env['Bindings'],
  friend: Friend,
  msg: OutgoingMessage,
): Promise<DeliverResult> {
  if (msg.type === 'flex') {
    return { ok: false, error: 'Telegramではフレックスメッセージを送信できません' };
  }
  if (!friend.telegram_account_id || !friend.telegram_chat_id) {
    return { ok: false, error: 'Telegram連絡先の情報が不足しています' };
  }
  const account = await getTelegramAccountById(env.DB, friend.telegram_account_id);
  if (!account) return { ok: false, error: 'Telegramアカウントが見つかりません' };

  const client = new TelegramClient(account.bot_token);
  let ok: boolean;
  if (msg.type === 'text') {
    ok = await client.sendText(friend.telegram_chat_id, msg.content);
  } else {
    const parsed = JSON.parse(msg.content) as { originalContentUrl: string };
    ok = await client.sendPhoto(friend.telegram_chat_id, parsed.originalContentUrl);
  }
  return ok ? { ok: true } : { ok: false, error: 'Telegramへの送信に失敗しました' };
}

/**
 * friend のチャネルに応じて送信し、成功時に messages_log へ outgoing を記録する。
 * 送信失敗時はログを残さず error を返す (UI/呼び出し元でハンドリング)。
 */
export async function deliverToFriend(
  env: Env['Bindings'],
  friend: Friend,
  msg: OutgoingMessage,
  opts: DeliverOptions,
): Promise<DeliverResult> {
  const channel = friendChannel(friend);
  const result = channel === 'telegram'
    ? await sendTelegram(env, friend, msg)
    : await sendLine(env, friend, msg);

  if (!result.ok) return result;

  const logId = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, sent_by_staff_id, channel, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(logId, friend.id, msg.type, msg.content, opts.source, opts.sentByStaffId ?? null, channel, jstNow())
    .run();

  return { ok: true, messageId: logId };
}
