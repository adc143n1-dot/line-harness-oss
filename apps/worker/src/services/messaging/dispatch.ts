import { jstNow, getLineAccountById, getTelegramAccountById, getPersonalLineAccountById } from '@line-crm/db';
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

async function sendPersonalLine(
  env: Env['Bindings'],
  friend: Friend,
  msg: OutgoingMessage,
): Promise<DeliverResult> {
  // 個人LINEには公式APIが無いため、外部ブリッジ(非公式クライアント常駐サーバー)に
  // HTTP で送信を委譲する。flex は LINE公式アカウント専用の概念で個人LINEでは扱えない。
  // 画像は MVP では未対応 (契約は用意済みだが実配線は今後)。
  if (msg.type === 'flex') {
    return { ok: false, error: '個人LINEではフレックスメッセージを送信できません' };
  }
  if (msg.type === 'image') {
    return { ok: false, error: '個人LINEの画像送信は未対応です' };
  }
  if (!friend.personal_line_account_id || !friend.personal_line_user_id) {
    return { ok: false, error: '個人LINE連絡先の情報が不足しています' };
  }
  const account = await getPersonalLineAccountById(env.DB, friend.personal_line_account_id);
  if (!account) return { ok: false, error: '個人LINEアカウントが見つかりません' };
  const base = (account.bridge_base_url ?? '').replace(/\/$/, '');
  if (!base) return { ok: false, error: 'ブリッジURL(bridge_base_url)が未設定です' };

  let res: Response;
  try {
    res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${account.bridge_secret}`,
      },
      body: JSON.stringify({ to: friend.personal_line_user_id, type: 'text', content: msg.content }),
    });
  } catch (err) {
    console.error('[personal-line] bridge send error:', err);
    return { ok: false, error: 'ブリッジへの送信に失敗しました' };
  }
  if (!res.ok) {
    console.error('[personal-line] bridge send failed:', res.status, await res.text().catch(() => ''));
    return { ok: false, error: `ブリッジ送信エラー (HTTP ${res.status})` };
  }
  return { ok: true };
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
  const result =
    channel === 'telegram'
      ? await sendTelegram(env, friend, msg)
      : channel === 'personal_line'
        ? await sendPersonalLine(env, friend, msg)
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
