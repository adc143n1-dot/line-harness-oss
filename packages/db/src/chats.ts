import { jstNow } from './utils.js';
// オペレーター＆チャット管理クエリヘルパー

export type ChatRepliedBy = 'operator' | 'user';

/** 進行状態 (status) とは独立した成果。VIP は顧客属性なのでタグ側で扱う。 */
export type ChatOutcome = 'converted' | 'lost';

export interface ChatRow {
  id: string;
  friend_id: string;
  operator_id: string | null;
  status: string;
  notes: string | null;
  last_message_at: string | null;
  /** 担当者が割り当てられた時刻 (未割当なら null) */
  assigned_at: string | null;
  /** 顧客の待ちに対して最初にスタッフが応答した時刻 (初回応答時間の算出用) */
  first_response_at: string | null;
  /** status が resolved になった時刻 */
  resolved_at: string | null;
  /** 直近のやり取りの時刻 (放置検知用) */
  last_activity_at: string | null;
  /** 直近に発言したのがスタッフか顧客か (放置検知用) */
  last_replied_by: ChatRepliedBy | null;
  /** 成果 (converted / lost)。進行状態とは独立 */
  outcome: ChatOutcome | null;
  /** 楽観ロック用。updateChat が更新のたびに +1 する */
  version: number;
  created_at: string;
  updated_at: string;
}

// operators テーブルは 071 で廃止。担当者は staff_members を参照する。

// --- チャット ---

export async function getChats(db: D1Database, opts: { status?: string; operatorId?: string } = {}): Promise<ChatRow[]> {
  if (opts.status && opts.operatorId) {
    const result = await db.prepare(`SELECT * FROM chats WHERE status = ? AND operator_id = ? ORDER BY last_message_at DESC`)
      .bind(opts.status, opts.operatorId).all<ChatRow>();
    return result.results;
  }
  if (opts.status) {
    const result = await db.prepare(`SELECT * FROM chats WHERE status = ? ORDER BY last_message_at DESC`)
      .bind(opts.status).all<ChatRow>();
    return result.results;
  }
  if (opts.operatorId) {
    const result = await db.prepare(`SELECT * FROM chats WHERE operator_id = ? ORDER BY last_message_at DESC`)
      .bind(opts.operatorId).all<ChatRow>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM chats ORDER BY last_message_at DESC`).all<ChatRow>();
  return result.results;
}

export async function getChatById(db: D1Database, id: string): Promise<ChatRow | null> {
  return db.prepare(`SELECT * FROM chats WHERE id = ?`).bind(id).first<ChatRow>();
}

export async function getChatByFriendId(db: D1Database, friendId: string): Promise<ChatRow | null> {
  return db.prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`).bind(friendId).first<ChatRow>();
}

export async function createChat(
  db: D1Database,
  input: { friendId: string; operatorId?: string },
): Promise<ChatRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  // 1 friend = 1 chat 行 (idx_chats_friend_unique)。同時実行でも重複しないよう
  // WHERE NOT EXISTS + OR IGNORE で原子挿入し、挿入の成否に関わらず既存行を返して収束する。
  await db.prepare(
    `INSERT OR IGNORE INTO chats (id, friend_id, operator_id, last_message_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`,
  )
    .bind(id, input.friendId, input.operatorId ?? null, now, now, now, input.friendId).run();
  return (await getChatByFriendId(db, input.friendId))!;
}

export async function updateChat(
  db: D1Database,
  id: string,
  updates: Partial<{
    operatorId: string | null;
    status: string;
    notes: string;
    lastMessageAt: string;
    assignedAt: string | null;
    firstResponseAt: string | null;
    resolvedAt: string | null;
    lastActivityAt: string | null;
    lastRepliedBy: ChatRepliedBy | null;
    outcome: ChatOutcome | null;
  }>,
  opts: { expectedVersion?: number } = {},
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.operatorId !== undefined) { sets.push('operator_id = ?'); values.push(updates.operatorId); }
  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.notes !== undefined) { sets.push('notes = ?'); values.push(updates.notes); }
  if (updates.lastMessageAt !== undefined) { sets.push('last_message_at = ?'); values.push(updates.lastMessageAt); }
  if (updates.assignedAt !== undefined) { sets.push('assigned_at = ?'); values.push(updates.assignedAt); }
  if (updates.firstResponseAt !== undefined) { sets.push('first_response_at = ?'); values.push(updates.firstResponseAt); }
  if (updates.resolvedAt !== undefined) { sets.push('resolved_at = ?'); values.push(updates.resolvedAt); }
  if (updates.lastActivityAt !== undefined) { sets.push('last_activity_at = ?'); values.push(updates.lastActivityAt); }
  if (updates.lastRepliedBy !== undefined) { sets.push('last_replied_by = ?'); values.push(updates.lastRepliedBy); }
  if (updates.outcome !== undefined) { sets.push('outcome = ?'); values.push(updates.outcome); }
  if (sets.length === 0) return true;
  // 楽観ロックの基準。実際に列が変わる更新のたびに +1 する。
  sets.push('version = version + 1');
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);

  // expectedVersion 指定時は WHERE に version を含める。読み込んでから書き込む
  // までの間に他のスタッフが更新していれば changes=0 になり、false を返す。
  const where = opts.expectedVersion === undefined ? 'id = ?' : 'id = ? AND version = ?';
  if (opts.expectedVersion !== undefined) values.push(opts.expectedVersion);

  const result = await db
    .prepare(`UPDATE chats SET ${sets.join(', ')} WHERE ${where}`)
    .bind(...values)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 友だちからメッセージ受信時にチャットを作成/更新 */
export async function upsertChatOnMessage(db: D1Database, friendId: string): Promise<ChatRow> {
  const now = jstNow();
  // createChat はレースで負けた場合も相手が作った行を返すので、必ずその行に対して
  // 受信時の更新 (resolved→unread, last_message_at) を適用する。挿入直後の自行にも
  // 適用されるが no-op 相当なので害はない。
  const chat = (await getChatByFriendId(db, friendId)) ?? (await createChat(db, { friendId }));
  const newStatus = chat.status === 'resolved' ? 'unread' : chat.status;
  // 顧客からの受信なので last_replied_by='user'。放置検知はこの2列だけを見る。
  await updateChat(db, chat.id, {
    status: newStatus,
    lastMessageAt: now,
    lastActivityAt: now,
    lastRepliedBy: 'user',
  });
  return (await getChatById(db, chat.id))!;
}
