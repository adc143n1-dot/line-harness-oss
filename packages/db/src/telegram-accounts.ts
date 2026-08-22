import { jstNow } from './utils.js';

// telegram_accounts の CRUD (line-accounts.ts のTelegram版)。
// bot_token / webhook_secret は line_accounts の access token 同様の平文列方針。

export interface TelegramAccount {
  id: string;
  bot_token: string;
  bot_username: string;
  webhook_secret: string;
  name: string;
  is_active: number;
  country: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export async function getTelegramAccounts(db: D1Database): Promise<TelegramAccount[]> {
  const res = await db
    .prepare(`SELECT * FROM telegram_accounts ORDER BY display_order ASC, created_at ASC`)
    .all<TelegramAccount>();
  return res.results;
}

export async function getTelegramAccountById(
  db: D1Database,
  id: string,
): Promise<TelegramAccount | null> {
  const row = await db
    .prepare(`SELECT * FROM telegram_accounts WHERE id = ?`)
    .bind(id)
    .first<TelegramAccount>();
  return row ?? null;
}

export interface CreateTelegramAccountInput {
  botToken: string;
  botUsername: string;
  webhookSecret: string;
  name: string;
  country?: string | null;
}

export async function createTelegramAccount(
  db: D1Database,
  input: CreateTelegramAccountInput,
): Promise<TelegramAccount> {
  const id = crypto.randomUUID();
  const now = jstNow();
  // 表示順は末尾に付ける
  const maxRow = await db
    .prepare(`SELECT COALESCE(MAX(display_order), -1) AS m FROM telegram_accounts`)
    .first<{ m: number }>();
  const order = (maxRow?.m ?? -1) + 1;
  await db
    .prepare(
      `INSERT INTO telegram_accounts
         (id, bot_token, bot_username, webhook_secret, name, is_active, country, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.botToken,
      input.botUsername.replace(/^@/, ''),
      input.webhookSecret,
      input.name,
      input.country ?? null,
      order,
      now,
      now,
    )
    .run();
  return (await getTelegramAccountById(db, id))!;
}

export interface UpdateTelegramAccountInput {
  botToken?: string;
  botUsername?: string;
  webhookSecret?: string;
  name?: string;
  isActive?: boolean;
  country?: string | null;
  displayOrder?: number;
}

export async function updateTelegramAccount(
  db: D1Database,
  id: string,
  input: UpdateTelegramAccountInput,
): Promise<TelegramAccount | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.botToken !== undefined) { sets.push('bot_token = ?'); binds.push(input.botToken); }
  if (input.botUsername !== undefined) { sets.push('bot_username = ?'); binds.push(input.botUsername.replace(/^@/, '')); }
  if (input.webhookSecret !== undefined) { sets.push('webhook_secret = ?'); binds.push(input.webhookSecret); }
  if (input.name !== undefined) { sets.push('name = ?'); binds.push(input.name); }
  if (input.isActive !== undefined) { sets.push('is_active = ?'); binds.push(input.isActive ? 1 : 0); }
  if (input.country !== undefined) { sets.push('country = ?'); binds.push(input.country); }
  if (input.displayOrder !== undefined) { sets.push('display_order = ?'); binds.push(input.displayOrder); }
  if (sets.length === 0) return getTelegramAccountById(db, id);

  sets.push('updated_at = ?');
  binds.push(jstNow());
  binds.push(id);
  await db
    .prepare(`UPDATE telegram_accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getTelegramAccountById(db, id);
}

export async function deleteTelegramAccount(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM telegram_accounts WHERE id = ?`).bind(id).run();
}
