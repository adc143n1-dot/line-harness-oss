import { jstNow } from './utils.js';

// personal_line_accounts の CRUD (telegram-accounts.ts の個人LINE版)。
// 個人LINEには公式APIが無く、外部ブリッジ(非公式クライアント常駐サーバー)経由で
// 送受信する。ここが保持するのはブリッジとの接続情報のみ。
//   bridge_base_url : 送信時に POST する外部ブリッジの基点URL (未設定なら送信不可)。
//   bridge_secret   : 送信(ハーネス→ブリッジ)の Bearer に使う共有シークレット。
//   inbound_secret  : 受信(ブリッジ→ハーネス Webフック)の X-Bridge-Secret 照合用。
// 秘匿列は line_accounts / telegram_accounts 同様の平文列方針。

export interface PersonalLineAccount {
  id: string;
  name: string;
  bridge_base_url: string | null;
  bridge_secret: string;
  inbound_secret: string;
  is_active: number;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export async function getPersonalLineAccounts(db: D1Database): Promise<PersonalLineAccount[]> {
  const res = await db
    .prepare(`SELECT * FROM personal_line_accounts ORDER BY display_order ASC, created_at ASC`)
    .all<PersonalLineAccount>();
  return res.results;
}

export async function getPersonalLineAccountById(
  db: D1Database,
  id: string,
): Promise<PersonalLineAccount | null> {
  const row = await db
    .prepare(`SELECT * FROM personal_line_accounts WHERE id = ?`)
    .bind(id)
    .first<PersonalLineAccount>();
  return row ?? null;
}

export interface CreatePersonalLineAccountInput {
  name: string;
  bridgeBaseUrl?: string | null;
  bridgeSecret: string;
  inboundSecret: string;
}

export async function createPersonalLineAccount(
  db: D1Database,
  input: CreatePersonalLineAccountInput,
): Promise<PersonalLineAccount> {
  const id = crypto.randomUUID();
  const now = jstNow();
  // 表示順は末尾に付ける
  const maxRow = await db
    .prepare(`SELECT COALESCE(MAX(display_order), -1) AS m FROM personal_line_accounts`)
    .first<{ m: number }>();
  const order = (maxRow?.m ?? -1) + 1;
  await db
    .prepare(
      `INSERT INTO personal_line_accounts
         (id, name, bridge_base_url, bridge_secret, inbound_secret, is_active, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      input.bridgeBaseUrl ?? null,
      input.bridgeSecret,
      input.inboundSecret,
      order,
      now,
      now,
    )
    .run();
  return (await getPersonalLineAccountById(db, id))!;
}

export interface UpdatePersonalLineAccountInput {
  name?: string;
  bridgeBaseUrl?: string | null;
  bridgeSecret?: string;
  inboundSecret?: string;
  isActive?: boolean;
  displayOrder?: number;
}

export async function updatePersonalLineAccount(
  db: D1Database,
  id: string,
  input: UpdatePersonalLineAccountInput,
): Promise<PersonalLineAccount | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.name !== undefined) { sets.push('name = ?'); binds.push(input.name); }
  if (input.bridgeBaseUrl !== undefined) { sets.push('bridge_base_url = ?'); binds.push(input.bridgeBaseUrl); }
  if (input.bridgeSecret !== undefined) { sets.push('bridge_secret = ?'); binds.push(input.bridgeSecret); }
  if (input.inboundSecret !== undefined) { sets.push('inbound_secret = ?'); binds.push(input.inboundSecret); }
  if (input.isActive !== undefined) { sets.push('is_active = ?'); binds.push(input.isActive ? 1 : 0); }
  if (input.displayOrder !== undefined) { sets.push('display_order = ?'); binds.push(input.displayOrder); }
  if (sets.length === 0) return getPersonalLineAccountById(db, id);

  sets.push('updated_at = ?');
  binds.push(jstNow());
  binds.push(id);
  await db
    .prepare(`UPDATE personal_line_accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getPersonalLineAccountById(db, id);
}

export async function deletePersonalLineAccount(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM personal_line_accounts WHERE id = ?`).bind(id).run();
}
