import { Hono } from 'hono';
import {
  jstNow,
  getTelegramAccountById,
  upsertTelegramFriend,
  upsertChatOnMessage,
} from '@line-crm/db';
import { TelegramClient } from '../services/telegram/client.js';
import { fireEvent } from '../services/event-bus.js';
import type { Env } from '../index.js';

const telegram = new Hono<Env>();

type TelegramPhotoSize = { file_id?: string; file_unique_id?: string; width?: number };
type TelegramMessage = {
  text?: string;
  caption?: string;
  from?: { id?: number | string; first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
  chat?: { id?: number | string };
  photo?: TelegramPhotoSize[];
};
type TelegramUpdate = {
  message?: TelegramMessage;
};

function telegramDisplayName(from: TelegramMessage['from']): string | null {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (from.username) return `@${from.username}`;
  return null;
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    // Telegram への返信失敗は紐付け自体の成否とは切り離す (再送は Telegram 側が行う)
    console.error('[telegram] sendMessage failed:', res.status, await res.text().catch(() => ''));
  }
}

/**
 * 送信元が Telegram であることを、setWebhook 時に登録した secret_token で検証する。
 * このエンドポイントは認証を外しているため、この検証が唯一の防御線になる。
 * secret が未設定の環境では全リクエストを拒否する (fail closed)。
 */
function isFromTelegram(c: { env: Env['Bindings']; req: { header(name: string): string | undefined } }): boolean {
  const expected = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[telegram] TELEGRAM_WEBHOOK_SECRET is not set — rejecting webhook');
    return false;
  }
  return c.req.header('X-Telegram-Bot-Api-Secret-Token') === expected;
}

telegram.post('/api/telegram/webhook', async (c) => {
  if (!isFromTelegram(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    return c.json({ ok: true });
  }

  const text = update.message?.text ?? '';
  const telegramUserId = update.message?.from?.id;
  const tgChatId = update.message?.chat?.id;
  const botToken = c.env.TELEGRAM_BOT_TOKEN;

  // 未対応のメッセージは黙って 200 を返す (Telegram の再送を止めるため)
  if (!text.startsWith('/start ') || telegramUserId == null || tgChatId == null || !botToken) {
    return c.json({ ok: true });
  }

  const token = text.slice('/start '.length).trim();
  const now = jstNow();

  // 使用済みマークを先に、条件付き UPDATE で原子的に行う。
  // SELECT してから UPDATE すると、同じリンクを二重にタップした場合に
  // 両方が有効と判定されうる。changes=0 なら無効/期限切れ/使用済み。
  const claim = await c.env.DB
    .prepare(
      `UPDATE tg_invite_tokens SET used_at = ?
        WHERE token = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(now, token, now)
    .run();

  if (!claim.meta.changes) {
    await sendTelegramMessage(
      botToken,
      String(tgChatId),
      '❌ このリンクは無効か、期限切れ、またはすでに使用済みです。担当スタッフに再発行を依頼してください。',
    );
    return c.json({ ok: true });
  }

  const row = await c.env.DB
    .prepare(`SELECT friend_id FROM tg_invite_tokens WHERE token = ?`)
    .bind(token)
    .first<{ friend_id: string }>();

  if (!row) return c.json({ ok: true });

  try {
    await c.env.DB
      .prepare(`UPDATE friends SET telegram_user_id = ?, tg_verified_at = ? WHERE id = ?`)
      .bind(String(telegramUserId), now, row.friend_id)
      .run();
  } catch (err) {
    // friends.telegram_user_id は部分 UNIQUE。既に別の友だちに紐付いている
    // Telegram アカウントで開かれた場合はここに来る。トークンは使用済みの
    // ままにする (再利用させない)。
    console.error('[telegram] link failed:', err);
    await sendTelegramMessage(
      botToken,
      String(tgChatId),
      '❌ この Telegram アカウントは既に別の方と連携済みです。担当スタッフにご連絡ください。',
    );
    return c.json({ ok: true });
  }

  await sendTelegramMessage(botToken, String(tgChatId), '✅ 認証が完了しました。担当スタッフからご案内します。');
  return c.json({ ok: true });
});

// ── 複数Bot対応の受信 webhook (Phase 2) ───────────────────────────────────────
// URL: /api/telegram/webhook/:accountId  (telegram_accounts.id ごと)
// setWebhook 時に登録した secret_token を、そのアカウントの webhook_secret と照合。
// 一般メッセージ(text/photo)を Telegram 連絡先 + messages_log + chat に変換する。
telegram.post('/api/telegram/webhook/:accountId', async (c) => {
  const accountId = c.req.param('accountId');
  const account = await getTelegramAccountById(c.env.DB, accountId);
  // アカウント不明・無効・secret不一致は 401 (Telegram には200を返さず、誤設定に気づけるように)
  if (!account || account.is_active !== 1) {
    return c.json({ success: false, error: 'Unknown or inactive Telegram account' }, 401);
  }
  if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== account.webhook_secret) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    return c.json({ ok: true });
  }

  const msg = update.message;
  const from = msg?.from;
  const tgUserId = from?.id;
  const tgChatId = msg?.chat?.id;
  // Bot 自身/不完全な更新は無視 (200 で再送を止める)
  if (!msg || from?.is_bot || tgUserId == null || tgChatId == null) {
    return c.json({ ok: true });
  }

  const client = new TelegramClient(account.bot_token);
  const text = msg.text ?? '';

  // /start <token> は既存の紐付けフローに委譲 (LINE友だちにTelegramを紐付ける)。
  // ただし紐付けが成立してもしなくても、以降のチャットは Telegram 連絡先として扱う。
  // ここでは新規/既存の Telegram 連絡先を作成/更新してから本文を記録する。
  const friend = await upsertTelegramFriend(c.env.DB, {
    telegramAccountId: account.id,
    telegramUserId: String(tgUserId),
    telegramChatId: String(tgChatId),
    displayName: telegramDisplayName(from),
  });

  // /start は挨拶コマンドなので本文ログ・chat化はしない (LINE の follow と同様の扱い)
  if (text.startsWith('/start')) {
    await client.sendText(
      String(tgChatId),
      'メッセージありがとうございます。担当者が確認のうえご返信します。',
    );
    return c.json({ ok: true });
  }

  const now = jstNow();
  const logId = crypto.randomUUID();

  // 写真: 最大サイズを取得して R2 に保存し、image としてログ (既存レンダラ互換)
  if (msg.photo && msg.photo.length > 0 && c.env.IMAGES && c.env.WORKER_URL) {
    const largest = msg.photo[msg.photo.length - 1];
    let content = '[画像]';
    if (largest?.file_id && largest.file_unique_id) {
      const stored = await client.fetchAndStorePhoto({
        r2: c.env.IMAGES,
        workerUrl: c.env.WORKER_URL,
        accountId: account.id,
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id,
      });
      if (stored) content = JSON.stringify(stored);
    }
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, channel, created_at)
         VALUES (?, ?, 'incoming', 'image', ?, 'telegram', 'telegram', ?)`,
      )
      .bind(logId, friend.id, content, now)
      .run();
    await upsertChatOnMessage(c.env.DB, friend.id);
    await fireEvent(c.env.DB, 'message_received', { friendId: friend.id });
    return c.json({ ok: true });
  }

  // テキスト (キャプション付き写真以外)。空メッセージ(位置情報等)はラベル化。
  const body = text || msg.caption || '[メッセージ]';
  await c.env.DB
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, channel, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, 'telegram', 'telegram', ?)`,
    )
    .bind(logId, friend.id, body, now)
    .run();
  await upsertChatOnMessage(c.env.DB, friend.id);
  await fireEvent(c.env.DB, 'message_received', { friendId: friend.id });
  return c.json({ ok: true });
});

export { telegram };
