import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

const telegram = new Hono<Env>();

type TelegramUpdate = {
  message?: {
    text?: string;
    from?: { id?: number | string };
    chat?: { id?: number | string };
  };
};

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

export { telegram };
