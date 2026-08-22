import { Hono } from 'hono';
import {
  getTelegramAccounts,
  getTelegramAccountById,
  createTelegramAccount,
  updateTelegramAccount,
  deleteTelegramAccount,
} from '@line-crm/db';
import type { TelegramAccount } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { TelegramClient } from '../services/telegram/client.js';
import type { Env } from '../index.js';

const telegramAccounts = new Hono<Env>();

// bot_token / webhook_secret は秘匿。一覧では末尾のみ表示し、UI が「設定済み」を
// 判定できるようにする (line_accounts の access token を伏せるのと同じ方針)。
function serialize(row: TelegramAccount, workerUrl?: string) {
  const base = (workerUrl ?? '').replace(/\/$/, '');
  return {
    id: row.id,
    name: row.name,
    botUsername: row.bot_username,
    isActive: Boolean(row.is_active),
    country: row.country,
    displayOrder: row.display_order,
    botTokenSet: Boolean(row.bot_token),
    botTokenLast4: row.bot_token ? row.bot_token.slice(-4) : null,
    // このアカウント宛の webhook URL (BotFather/setWebhook に登録する)
    webhookUrl: base ? `${base}/api/telegram/webhook/${row.id}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET 一覧
telegramAccounts.get('/api/telegram-accounts', requireRole('owner', 'admin', 'staff'), async (c) => {
  const rows = await getTelegramAccounts(c.env.DB);
  return c.json({ success: true, data: rows.map((r) => serialize(r, c.env.WORKER_URL)) });
});

// POST 作成 (owner のみ)。作成後、Telegram に setWebhook まで行う。
telegramAccounts.post('/api/telegram-accounts', requireRole('owner'), async (c) => {
  const body = await c.req
    .json<{ name?: string; botToken?: string; botUsername?: string; country?: string | null }>()
    .catch(() => ({} as Record<string, never>));
  const name = (body.name ?? '').trim();
  const botToken = (body.botToken ?? '').trim();
  const botUsername = (body.botUsername ?? '').trim();
  if (!name || !botToken || !botUsername) {
    return c.json({ success: false, error: 'name・botToken・botUsername は必須です' }, 400);
  }
  // webhook_secret は自動生成 (Telegram に登録し、受信時に照合する)
  const webhookSecret = crypto.randomUUID().replace(/-/g, '');

  const account = await createTelegramAccount(c.env.DB, {
    botToken,
    botUsername,
    webhookSecret,
    name,
    country: body.country ?? null,
  });

  // setWebhook: 失敗しても作成は成立させる (UIから後で再設定できるように結果を返す)
  let webhookRegistered = false;
  const base = (c.env.WORKER_URL ?? '').replace(/\/$/, '');
  if (base) {
    const client = new TelegramClient(botToken);
    webhookRegistered = await client.setWebhook(
      `${base}/api/telegram/webhook/${account.id}`,
      webhookSecret,
    );
  }

  return c.json({
    success: true,
    data: { account: serialize(account, c.env.WORKER_URL), webhookRegistered },
  });
});

// PUT 更新 (owner のみ)。botToken 変更時は setWebhook も貼り直す。
telegramAccounts.put('/api/telegram-accounts/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id')!;
  const existing = await getTelegramAccountById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'not found' }, 404);

  const body = await c.req
    .json<{ name?: string; botToken?: string; botUsername?: string; isActive?: boolean; country?: string | null }>()
    .catch(() => ({} as Record<string, never>));

  const updated = await updateTelegramAccount(c.env.DB, id, {
    name: body.name,
    botToken: body.botToken,
    botUsername: body.botUsername,
    isActive: body.isActive,
    country: body.country,
  });

  let webhookRegistered: boolean | null = null;
  const base = (c.env.WORKER_URL ?? '').replace(/\/$/, '');
  if (updated && body.botToken && base) {
    const client = new TelegramClient(body.botToken);
    webhookRegistered = await client.setWebhook(
      `${base}/api/telegram/webhook/${id}`,
      updated.webhook_secret,
    );
  }

  return c.json({
    success: true,
    data: { account: updated ? serialize(updated, c.env.WORKER_URL) : null, webhookRegistered },
  });
});

// POST 再登録 (owner のみ) — 表示中のwebhook URLをTelegramに貼り直すだけ。
telegramAccounts.post('/api/telegram-accounts/:id/register-webhook', requireRole('owner'), async (c) => {
  const id = c.req.param('id')!;
  const account = await getTelegramAccountById(c.env.DB, id);
  if (!account) return c.json({ success: false, error: 'not found' }, 404);
  const base = (c.env.WORKER_URL ?? '').replace(/\/$/, '');
  if (!base) return c.json({ success: false, error: 'WORKER_URL 未設定' }, 400);
  const client = new TelegramClient(account.bot_token);
  const ok = await client.setWebhook(`${base}/api/telegram/webhook/${id}`, account.webhook_secret);
  return c.json({ success: ok, data: { webhookRegistered: ok } });
});

// DELETE (owner のみ)
telegramAccounts.delete('/api/telegram-accounts/:id', requireRole('owner'), async (c) => {
  await deleteTelegramAccount(c.env.DB, c.req.param('id')!);
  return c.json({ success: true });
});

export { telegramAccounts };
