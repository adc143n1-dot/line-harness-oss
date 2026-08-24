import { Hono } from 'hono';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getChats,
  listChatNotes,
  createChatNote,
  getChatById,
  createChat,
  getFriendById,
  getLineAccountById,
  getStaffById,
  updateChat,
  jstNow,
  toJstString,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { persistableStaffId } from '../middleware/auth.js';
import { requireRole } from '../middleware/role-guard.js';
import { fireEvent } from '../services/event-bus.js';
import { discordOAuthConfigured, buildDiscordAuthorizeUrl } from '../services/discord-oauth.js';

const chats = new Hono<Env>();

function clampLoadingSeconds(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 5;
  return Math.min(60, Math.max(5, n));
}

async function startLoadingAnimation(
  accessToken: string,
  chatId: string,
  loadingSeconds: number,
): Promise<void> {
  const response = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatId, loadingSeconds }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail
        ? `LINE API error: ${response.status} - ${detail}`
        : `LINE API error: ${response.status}`,
    );
  }
}

type ChatLike = {
  id: string;
  friend_id: string;
  operator_id: string | null;
  status: string;
  notes: string | null;
  last_message_at: string | null;
  assigned_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  last_activity_at: string | null;
  last_replied_by: 'operator' | 'user' | null;
  version: number;
  created_at: string;
  updated_at: string;
};

// id は chats.id もしくは friend.id のどちらか。friend.id のときは chats 行を遅延作成する。
// push / broadcast / scenario 配信だけを受けた友だちもチャット画面に現れるため、ここで lazy create が必要。
// 新規作成する場合は status='resolved' にし、last_message_at は messages_log の実際の最終時刻を使う
// （jstNow を入れると一覧並び順が壊れるため）。
async function resolveOrCreateChat(db: D1Database, id: string): Promise<ChatLike | null> {
  const existing = await getChatById(db, id);
  if (existing) return existing as ChatLike;
  const friend = await getFriendById(db, id);
  if (!friend) return null;
  // 最新行を選ぶ (unanswered-inbox / conversations の latest_chat CTE と同じ基準)。
  // 最古行を選ぶと、旧重複データがある DB で読み手と別の行に status を書いてしまう。
  const byFriend = await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>();
  if (byFriend) return byFriend;

  const lastMsg = await db
    .prepare(
      `SELECT MAX(created_at) AS last FROM messages_log WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')`,
    )
    .bind(friend.id)
    .first<{ last: string | null }>();
  const newId = crypto.randomUUID();
  const now = jstNow();
  const lastMessageAt = lastMsg?.last ?? null;
  // 同時実行で二重挿入されないように WHERE NOT EXISTS + OR IGNORE で原子挿入。
  // 挿入結果に関わらず最新行を返して収束。
  await db
    .prepare(
      `INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
       SELECT ?, ?, 'resolved', ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`,
    )
    .bind(newId, friend.id, lastMessageAt, now, now, friend.id)
    .run();
  return (await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>())!;
}

async function resolveFriendAndAccessToken(
  db: D1Database,
  friendId: string,
  defaultAccessToken: string,
) {
  const friend = await getFriendById(db, friendId);
  if (!friend) {
    return { friend: null, accessToken: defaultAccessToken };
  }

  if (!friend.line_account_id) {
    return { friend, accessToken: defaultAccessToken };
  }

  const account = await getLineAccountById(db, friend.line_account_id);
  if (!account) {
    return { friend, accessToken: defaultAccessToken };
  }

  return { friend, accessToken: account.channel_access_token };
}

// ========== オペレーターCRUD ==========

// /api/operators は 071 で廃止。担当者候補は GET /api/staff から引く。

// ========== チャットCRUD ==========

chats.get('/api/chats', async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const operatorId = c.req.query('operatorId') ?? undefined;
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const unansweredOnly =
      c.req.query('unansweredOnly') === 'true' || c.req.query('unansweredOnly') === '1';

    let unansweredMap: Map<string, { lastIncomingAt: string; lastIncomingContent: string; lastIncomingType: string }> | null = null;
    if (unansweredOnly) {
      const { getUnansweredRowsMap } = await import('../services/unanswered-inbox.js');
      unansweredMap = await getUnansweredRowsMap(c.env.DB);
      // 空 Map のとき = 未対応ゼロ。早期 return で空配列を返す。
      if (unansweredMap.size === 0) {
        return c.json({ success: true, data: [] });
      }
    }

    // List everyone who has any message history (incoming or outgoing — push/broadcast/scenario included)
    // PLUS any chats row that exists even before any messages_log entry is written.
    // Source = messages_log ∪ chats.friend_id; chats は status/operator/notes 用に LEFT JOIN で最新1件だけ採用。
    //
    // recent_msg CTE で friend_id ごとに最新の messages_log 行をひとつ取得し、本文 preview と
    // direction (incoming/outgoing) を一覧に出す。
    //
    // パフォーマンス対策 (2026-07-06 本番実測で全面改修):
    //   旧実装は messages_log (96k 行) を ROW_NUMBER × 2 + GROUP BY で 3 回スキャンし、
    //   さらに LIMIT なしで全 friend (10k 行) を返していた → 本番 D1 実測 3.47 秒 / 781k rows_read。
    //   新実装は (a) ROW_NUMBER を argmax GROUP BY に置換 (SQLite の bare-column +
    //   単一 MAX() は max 行の値を返す documented 挙動)、(b) CTE を MATERIALIZED して
    //   二重評価を防止、(c) page CTE で先に対象 friend を limit 件に確定してから
    //   preview を計算、(d) デフォルト LIMIT 300 (最終行は last_message_at DESC)。
    //   同条件の本番実測: 459ms / 165k rows_read (LIMIT 300 時)。
    //   - content は text のみ先頭 200 文字まで切り詰めて返す (flex/image など raw JSON を
    //     返すと broadcast 後の rows で multi-MB レスポンスになる)。
    //   - lineAccountId 指定時は messages_log スキャンを対象アカの friend に絞る。
    // LINEアカウントで絞る場合も、Telegram連絡先 (line_account_id が NULL) は
    // 統合受信箱として常に含める。Telegramはどの LINE アカウントにも属さないため。
    const accountFilterSql = lineAccountId
      ? `friend_id IN (SELECT id FROM friends WHERE line_account_id = ? OR channel = 'telegram')`
      : `1=1`;

    // unansweredOnly は取得後に unansweredMap と突合して絞るため全件必要。
    // SQLite は LIMIT に負値を渡すと「無制限」になる (documented 挙動)。
    const NO_LIMIT = -1;
    const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = unansweredOnly
      ? NO_LIMIT
      : Number.isFinite(limitParam)
        ? Math.min(1000, Math.max(1, limitParam))
        : 300;
    // カーソルページング: (last_message_at, friend_id) の複合カーソルより古い行を返す。
    // offset 方式は「取得の合間に新着で行が押し下げられた分が欠落する」構造問題が
    // あるため採用しない。friend_id は同時刻 (broadcast 一斉配信等) のタイブレーク。
    const beforeAt = c.req.query('beforeAt') || undefined;
    const beforeId = c.req.query('beforeId') || undefined;
    const useCursor = !unansweredOnly && Boolean(beforeAt && beforeId);

    const conditions: string[] = [];
    const conditionBindings: unknown[] = [];
    if (status) {
      conditions.push(`COALESCE(c.status, 'resolved') = ?`);
      conditionBindings.push(status);
    }
    if (operatorId === 'none') {
      // 「未割当のみ」フィルタ。chats 行が無い (未対応のまま誰も触っていない)
      // 友だちも未割当として扱うため IS NULL 判定 (LEFT JOIN 前提)。
      conditions.push('c.operator_id IS NULL');
    } else if (operatorId) {
      conditions.push('c.operator_id = ?');
      conditionBindings.push(operatorId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      conditionBindings.push(lineAccountId);
    }
    // status / operator filter は chats を参照するので、その時だけ page CTE 側でも
    // chats を lookup する (無条件時は 全friend × chats lookup を省く)。
    const pageNeedsChats = Boolean(status || operatorId);

    // preview は direction/source を問わず **実際の最新メッセージ** を表示する。
    // incoming を常に優先すると、プロキシ経由の manual/external 送信が messages_log に
    // 正しく保存されていても、一覧には何日も前の incoming とその日時が残って見える。
    // また page の並び順は最新 any なのにレスポンスの lastMessageAt だけ過去の incoming に
    // なるため、フロントが作るページング cursor と SQL のソートキーも食い違っていた。
    // 未対応モードだけは取得後に unansweredMap の incoming で明示的に上書きする。
    // text 以外 (flex/image/sticker 等) は content を NULL にして payload size を抑える
    // (フロントは type で 📋 Flex / 📷 画像 等のラベルを出すので content は不要)。
    // any_agg の bare column (content 等) は「単一 MAX() を含む集約は max 行の
    // 値を返す」という SQLite の documented 挙動で argmax として使っている。
    // 集約は page 確定後の friend に絞って実行する (全 friend 分の content を
    // materialize しない)。last_any は並び順決定専用のスリムな全走査 1 回のみ。
    const sql = `
      WITH last_any AS MATERIALIZED (
        SELECT friend_id, MAX(created_at) AS last_message_at
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND ${accountFilterSql}
        GROUP BY friend_id
      ),
      deduped AS MATERIALIZED (
        SELECT friend_id, MAX(last_message_at) AS last_message_at FROM (
          SELECT friend_id, last_message_at FROM last_any
          UNION ALL
          SELECT friend_id, last_message_at FROM chats WHERE ${accountFilterSql}
        ) GROUP BY friend_id
      ),
      page AS MATERIALIZED (
        SELECT d.friend_id, d.last_message_at
        FROM deduped d
        INNER JOIN friends f ON f.id = d.friend_id
        ${pageNeedsChats ? `LEFT JOIN chats c ON c.id = (
          SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
        )` : ''}
        WHERE 1=1
        ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
        ${useCursor ? 'AND (d.last_message_at < ? OR (d.last_message_at = ? AND d.friend_id < ?))' : ''}
        ORDER BY d.last_message_at DESC, d.friend_id DESC
        LIMIT ?
      ),
      any_agg AS (
        SELECT friend_id,
          CASE WHEN message_type = 'text' THEN SUBSTR(content, 1, 200) ELSE NULL END AS content,
          direction, message_type,
          MAX(created_at) AS created_at
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND friend_id IN (SELECT friend_id FROM page)
        GROUP BY friend_id
      ),
      recent_msg AS (
        SELECT friend_id, content, direction, message_type, created_at AS preview_at
        FROM any_agg
      )
      SELECT
        f.id AS id,
        f.id AS friend_id,
        f.display_name,
        f.picture_url,
        f.line_user_id,
        f.line_account_id,
        f.source,
        f.channel,
        f.telegram_user_id,
        f.discord_user_id,
        c.operator_id,
        COALESCE(c.status, 'resolved') AS status,
        c.outcome,
        COALESCE(c.version, 0) AS version,
        c.notes,
        COALESCE(rm.preview_at, d.last_message_at) AS last_message_at,
        rm.content AS last_message_content,
        rm.direction AS last_message_direction,
        rm.message_type AS last_message_type,
        COALESCE(c.created_at, d.last_message_at) AS created_at,
        COALESCE(c.updated_at, d.last_message_at) AS updated_at
      FROM page d
      INNER JOIN friends f ON f.id = d.friend_id
      LEFT JOIN chats c ON c.id = (
        SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN recent_msg rm ON rm.friend_id = f.id
      ORDER BY d.last_message_at DESC, d.friend_id DESC
    `;

    // placeholder 順 = SQL 出現順: last_any(account) → deduped 内 chats(account) →
    // page 条件 → cursor (beforeAt ×2 + beforeId) → LIMIT。
    // any_agg は page で friend が確定済みのため account filter 不要。
    const allBindings: unknown[] = [];
    if (lineAccountId) allBindings.push(lineAccountId, lineAccountId);
    allBindings.push(...conditionBindings);
    if (useCursor) allBindings.push(beforeAt, beforeAt, beforeId);
    allBindings.push(limit);
    const result = await c.env.DB.prepare(sql).bind(...allBindings).all();

    let data = result.results.map((ch: Record<string, unknown>) => ({
      id: ch.id as string,
      friendId: ch.friend_id,
      friendName: ch.display_name || '名前なし',
      friendPictureUrl: ch.picture_url || null,
      operatorId: ch.operator_id,
      status: ch.status,
      outcome: ch.outcome ?? null,
      version: ch.version ?? 0,
      source: ch.source ?? null,
      channel: (ch.channel as string) ?? 'line',
      telegramUserId: ch.telegram_user_id ?? null,
      discordUserId: ch.discord_user_id ?? null,
      notes: ch.notes,
      lastMessageAt: ch.last_message_at,
      lastMessageContent: ch.last_message_content || null,
      lastMessageDirection: ch.last_message_direction || null,
      lastMessageType: ch.last_message_type || null,
      createdAt: ch.created_at,
      updatedAt: ch.updated_at,
    }));

    if (unansweredMap) {
      // 未対応 row の preview / timestamp で上書きして Inbox と一貫させる
      data = data
        .filter((row) => unansweredMap!.has(row.id as string))
        .map((row) => {
          const u = unansweredMap!.get(row.id as string)!;
          return {
            ...row,
            lastMessageAt: u.lastIncomingAt,
            lastMessageContent: u.lastIncomingType === 'text' ? u.lastIncomingContent : null,
            lastMessageDirection: 'incoming' as const,
            lastMessageType: u.lastIncomingType,
          };
        })
        // 上書きで lastMessageAt が変わったので resort
        .sort((a, b) => {
          const aAt = typeof a.lastMessageAt === 'string' ? a.lastMessageAt : '';
          const bAt = typeof b.lastMessageAt === 'string' ? b.lastMessageAt : '';
          return bAt.localeCompare(aAt);
        });
    }

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.get('/api/chats/:id', async (c) => {
  try {
    const rawId = c.req.param('id');

    // id は chats.id または friend.id のどちらでもOK。
    // 優先順: chats.id 一致 → friend.id のとき chats.friend_id 最新行 → 何も無ければ friend のみで synthetic
    let chatRow = await getChatById(c.env.DB, rawId);
    let friendId: string | null = null;

    if (!chatRow) {
      const friendRow = await getFriendById(c.env.DB, rawId);
      if (!friendRow) return c.json({ success: false, error: 'Chat not found' }, 404);
      friendId = friendRow.id;
      // 同じ friend に紐づく chats 行があれば採用（lazy-create 後の再読みで status/notes を拾うため）
      const existing = await c.env.DB
        .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(friendRow.id)
        .first<{ id: string; friend_id: string; operator_id: string | null; status: string; notes: string | null; last_message_at: string | null; created_at: string; updated_at: string }>();
      if (existing) {
        chatRow = existing as Awaited<ReturnType<typeof getChatById>>;
      }
    }

    const resolvedFriendId = chatRow?.friend_id ?? friendId!;
    // 公開 ID は常に friend_id に統一する（lazy-create で ID が変わるのを防ぐため）。
    const responseId = resolvedFriendId;
    const operatorId = chatRow?.operator_id ?? null;
    const status = chatRow?.status ?? 'resolved';
    const notes = chatRow?.notes ?? null;
    const lastMessageAt = chatRow?.last_message_at ?? null;
    const createdAt = chatRow?.created_at ?? null;

    const friend = await c.env.DB
      .prepare(
        `SELECT display_name, picture_url, line_user_id, source, telegram_user_id, tg_verified_at,
                discord_user_id, discord_verified_at
         FROM friends WHERE id = ?`,
      )
      .bind(resolvedFriendId)
      .first<{
        display_name: string | null;
        picture_url: string | null;
        line_user_id: string;
        source: string | null;
        telegram_user_id: string | null;
        tg_verified_at: string | null;
        discord_user_id: string | null;
        discord_verified_at: string | null;
      }>();

    // 新しい1000件を取って昇順に戻す。LIMIT 200 ASC だと古い200件だけで broadcast/scenario 等の
    // 新しい push が欠落していた（Shu で 481件中 281件欠落のバグあり）。一覧側と同様に test 配信は除外。
    // 現状の最重量ユーザー(481件)の2倍バッファ。これ以上の履歴はページング未実装（Phase 2 TODO）。
    const messages = await c.env.DB
      .prepare(
        `SELECT id, friend_id, direction, message_type, content, created_at
         FROM messages_log
         WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')
         ORDER BY created_at DESC LIMIT 1000`,
      )
      .bind(resolvedFriendId)
      .all();
    messages.results = (messages.results as Record<string, unknown>[]).reverse();

    return c.json({
      success: true,
      data: {
        id: responseId,
        friendId: resolvedFriendId,
        friendName: friend?.display_name || '名前なし',
        friendPictureUrl: friend?.picture_url || null,
        operatorId,
        status,
        outcome: chatRow?.outcome ?? null,
        version: chatRow?.version ?? 0,
        snoozeUntil: (chatRow as (ChatLike & { snooze_until?: string | null }) | null)?.snooze_until ?? null,
        source: friend?.source ?? null,
        telegramUserId: friend?.telegram_user_id ?? null,
        tgVerifiedAt: friend?.tg_verified_at ?? null,
        discordUserId: friend?.discord_user_id ?? null,
        discordVerifiedAt: friend?.discord_verified_at ?? null,
        notes,
        lastMessageAt,
        createdAt,
        messages: (messages.results as Record<string, unknown>[]).map((m) => ({
          id: m.id,
          direction: m.direction,
          messageType: m.message_type,
          content: m.content,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats', async (c) => {
  try {
    const body = await c.req.json<{ friendId: string; operatorId?: string; lineAccountId?: string | null }>();
    if (!body.friendId) return c.json({ success: false, error: 'friendId is required' }, 400);
    const item = await createChat(c.env.DB, body);
    // Save line_account_id if provided
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE chats SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, item.id).run();
    }
    return c.json({ success: true, data: { id: item.id, friendId: item.friend_id, status: item.status } }, 201);
  } catch (err) {
    console.error('POST /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// チャットのアサイン/ステータス更新/ノート更新
chats.put('/api/chats/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = await resolveOrCreateChat(c.env.DB, id);
    if (!resolved) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<{
      operatorId?: string | null;
      status?: string;
      notes?: string;
      outcome?: 'converted' | 'lost' | null;
      expectedVersion?: number;
    }>();
    // 担当の変更は claim / release / assign の専用エンドポイントに一本化した。
    // ここで受けると「任意のスタッフが誰の担当でもロールガード無しに書き換え
    // られる」穴になるため、黙って無視ではなく明示的に 400 で拒否する。
    if (body.operatorId !== undefined) {
      return c.json(
        { success: false, error: '担当の変更は /claim /release /assign を使ってください' },
        400,
      );
    }
    // 計測列 (assigned_at / resolved_at 等) はサーバ側でのみ導出する。body を
    // そのまま渡すと KPI をクライアントから書き換えられるため、明示的に絞る。
    const now = jstNow();
    const updates: Parameters<typeof updateChat>[2] = {};
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status !== resolved.status) {
        updates.resolvedAt = body.status === 'resolved' ? now : null;
      }
    }
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.outcome !== undefined) updates.outcome = body.outcome;
    const applied = await updateChat(c.env.DB, resolved.id, updates, {
      expectedVersion: body.expectedVersion,
    });
    if (!applied) {
      // 読み込んでから保存するまでの間に他のスタッフが更新した
      return c.json({ success: false, error: 'Version conflict' }, 409);
    }
    const updated = await getChatById(c.env.DB, resolved.id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      // 公開 ID は friend_id に統一
      data: { id: updated.friend_id, friendId: updated.friend_id, operatorId: updated.operator_id, status: updated.status, outcome: updated.outcome ?? null, notes: updated.notes },
    });
  } catch (err) {
    console.error('PUT /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// オペレーター入力中のローディング表示を開始
chats.post('/api/chats/:id/loading', async (c) => {
  try {
    const chatId = c.req.param('id');
    const chat = await resolveOrCreateChat(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    let loadingSecondsInput: number | undefined;
    try {
      const body = await c.req.json<{ loadingSeconds?: number }>();
      loadingSecondsInput = body.loadingSeconds;
    } catch {
      loadingSecondsInput = undefined;
    }
    const loadingSeconds = clampLoadingSeconds(loadingSecondsInput);

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    await startLoadingAnimation(
      accessToken,
      friend.line_user_id,
      loadingSeconds,
    );

    return c.json({ success: true, data: { started: true, loadingSeconds } });
  } catch (err) {
    console.error('POST /api/chats/:id/loading error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return c.json({ success: false, error: message }, 500);
  }
});

// オペレーターからメッセージ送信
chats.post('/api/chats/:id/send', async (c) => {
  try {
    const chatId = c.req.param('id');
    const chat = await resolveOrCreateChat(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    const body = await c.req.json<{ messageType?: string; content: string; expectedVersion?: number }>();
    if (!body.content) return c.json({ success: false, error: 'content is required' }, 400);

    // version の確認は LINE へ push する「前」に行う。送ってから 409 を返すと
    // 相手にはメッセージが届いているのに UI 上は失敗扱いになる。
    if (body.expectedVersion !== undefined && body.expectedVersion !== chat.version) {
      return c.json({ success: false, error: 'Version conflict' }, 409);
    }

    const { friend } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const messageType = (body.messageType ?? 'text') as 'text' | 'image' | 'flex';
    // sent_by_staff_id は staff_members を参照するため、env API_KEY 認証の合成
    // ID (ENV_OWNER_STAFF_ID) では NULL を入れる。
    const sentByStaffId = persistableStaffId(c.get('staff'));

    // チャネル横断ディスパッチ (LINE / Telegram を friend.channel で出し分け)。
    // 送信成功時のみ messages_log に記録される。
    const { deliverToFriend } = await import('../services/messaging/dispatch.js');
    const delivered = await deliverToFriend(
      c.env,
      friend,
      { type: messageType, content: body.content },
      { source: 'manual', sentByStaffId },
    );
    if (!delivered.ok) {
      return c.json({ success: false, error: delivered.error ?? '送信に失敗しました' }, 400);
    }
    const logId = delivered.messageId!;

    // チャットの最終メッセージ日時を更新（chat.id を直接使う — friend_id で呼ばれても resolveOrCreateChat 済み）
    // first_response_at は最初のスタッフ返信時のみ記録する (初回応答時間の算出用)。
    const sentAt = jstNow();
    await updateChat(c.env.DB, chat.id, {
      status: 'in_progress',
      lastMessageAt: sentAt,
      lastActivityAt: sentAt,
      lastRepliedBy: 'operator',
      ...(chat.first_response_at ? {} : { firstResponseAt: sentAt }),
    });

    return c.json({ success: true, data: { sent: true, messageId: logId } });
  } catch (err) {
    console.error('POST /api/chats/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Telegram 誘導リンクを LINE で送る。
// トークンは 24 時間で失効し、再発行すると未使用の旧トークンは失効する
// (LINE のトーク履歴に残ったリンクが、いつまでも有効な紐付け用の認証情報に
//  ならないようにするため)。
chats.post('/api/chats/:id/invite-telegram', async (c) => {
  try {
    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    const botUsername = c.env.TELEGRAM_BOT_USERNAME;
    if (!botUsername) {
      return c.json({ success: false, error: 'TELEGRAM_BOT_USERNAME is not configured' }, 500);
    }

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);
    if ((friend as { telegram_user_id?: string | null }).telegram_user_id) {
      return c.json({ success: false, error: 'Already linked' }, 400);
    }

    const now = jstNow();
    const expiresAt = toJstString(new Date(Date.now() + 24 * 60 * 60 * 1000));

    await c.env.DB
      .prepare(
        `UPDATE tg_invite_tokens SET revoked_at = ?
          WHERE friend_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(now, friend.id)
      .run();

    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    await c.env.DB
      .prepare(
        `INSERT INTO tg_invite_tokens (token, friend_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(token, friend.id, now, expiresAt)
      .run();

    const inviteUrl = `https://t.me/${botUsername}?start=${token}`;
    const message = `詳しい案内はこちらの Telegram から↓\n${inviteUrl}\n（このリンクはあなた専用です。24時間で無効になります）`;

    const { LineClient } = await import('@line-crm/line-sdk');
    await new LineClient(accessToken).pushTextMessage(friend.line_user_id, message);

    // スタッフが送ったメッセージとして記録し、計測列も通常の送信と同じ扱いにする
    const sentByStaffId = persistableStaffId(c.get('staff'));
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, sent_by_staff_id, created_at) VALUES (?, ?, 'outgoing', 'text', ?, 'manual', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, message, sentByStaffId, now)
      .run();

    await updateChat(c.env.DB, chat.id, {
      status: 'in_progress',
      lastMessageAt: now,
      lastActivityAt: now,
      lastRepliedBy: 'operator',
      ...(chat.first_response_at ? {} : { firstResponseAt: now }),
    });

    return c.json({ success: true, data: { inviteUrl, expiresAt } });
  } catch (err) {
    console.error('POST /api/chats/:id/invite-telegram error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Discord 誘導リンクを LINE で送る (副業マッチング Phase C)。
// invite-telegram と全く同じ設計: トークンは24時間で失効し、再発行すると
// 未使用の旧トークンは失効する。ここでの「トークン」はそのまま Discord
// OAuth2 の state パラメータとしても使われる (discord-link.ts の callback で
// 消費される)。
chats.post('/api/chats/:id/invite-discord', async (c) => {
  try {
    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    const creds = {
      clientId: c.env.DISCORD_OAUTH_CLIENT_ID,
      clientSecret: c.env.DISCORD_OAUTH_CLIENT_SECRET,
      redirectUri: `${c.env.WORKER_URL || new URL(c.req.url).origin}/discord/callback`,
    };
    if (!discordOAuthConfigured(creds)) {
      return c.json({ success: false, error: 'Discord OAuth is not configured' }, 500);
    }

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);
    if ((friend as { discord_user_id?: string | null }).discord_user_id) {
      return c.json({ success: false, error: 'Already linked' }, 400);
    }

    const now = jstNow();
    const expiresAt = toJstString(new Date(Date.now() + 24 * 60 * 60 * 1000));

    await c.env.DB
      .prepare(
        `UPDATE discord_invite_tokens SET revoked_at = ?
          WHERE friend_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(now, friend.id)
      .run();

    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    await c.env.DB
      .prepare(
        `INSERT INTO discord_invite_tokens (token, friend_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(token, friend.id, now, expiresAt)
      .run();

    const inviteUrl = buildDiscordAuthorizeUrl(creds, token);
    const message = `詳しい案内はこちらの Discord から↓\n${inviteUrl}\n（このリンクはあなた専用です。24時間で無効になります）`;

    const { LineClient } = await import('@line-crm/line-sdk');
    await new LineClient(accessToken).pushTextMessage(friend.line_user_id, message);

    const sentByStaffId = persistableStaffId(c.get('staff'));
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, sent_by_staff_id, created_at) VALUES (?, ?, 'outgoing', 'text', ?, 'manual', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, message, sentByStaffId, now)
      .run();

    await updateChat(c.env.DB, chat.id, {
      status: 'in_progress',
      lastMessageAt: now,
      lastActivityAt: now,
      lastRepliedBy: 'operator',
      ...(chat.first_response_at ? {} : { firstResponseAt: now }),
    });

    return c.json({ success: true, data: { inviteUrl, expiresAt } });
  } catch (err) {
    console.error('POST /api/chats/:id/invite-discord error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 自分に引き取る (Claim)。
// 複数スタッフが同じ未対応キューを見る運用では、これが二重返信を止める主な仕組み。
// 既に他のスタッフが持っている場合は 409。意図的な引き取りは force で行う。
chats.post('/api/chats/:id/claim', async (c) => {
  try {
    const staffId = persistableStaffId(c.get('staff'));
    if (!staffId) {
      // env API_KEY 認証には staff_members 行が無く、担当者にできない
      return c.json(
        { success: false, error: 'スタッフとしてログインしてください (共有 API キーでは担当者になれません)' },
        400,
      );
    }

    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    let force = false;
    try {
      force = (await c.req.json<{ force?: boolean }>()).force === true;
    } catch {
      force = false;
    }

    if (chat.operator_id && chat.operator_id !== staffId && !force) {
      return c.json(
        { success: false, error: 'Already claimed', data: { operatorId: chat.operator_id } },
        409,
      );
    }

    const now = jstNow();
    const applied = await updateChat(
      c.env.DB,
      chat.id,
      {
        operatorId: staffId,
        assignedAt: now,
        // 未読のまま担当だけ付くと未対応キューに残り続けるので対応中にする
        ...(chat.status === 'unread' ? { status: 'in_progress' } : {}),
      },
      { expectedVersion: chat.version },
    );

    if (!applied) {
      // 読んでから書くまでの間に他のスタッフが触った
      return c.json({ success: false, error: 'Version conflict' }, 409);
    }

    const updated = await getChatById(c.env.DB, chat.id);
    return c.json({
      success: true,
      data: {
        id: updated?.friend_id,
        friendId: updated?.friend_id,
        operatorId: updated?.operator_id ?? null,
        status: updated?.status,
        version: updated?.version ?? 0,
      },
    });
  } catch (err) {
    console.error('POST /api/chats/:id/claim error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 未対応キューから「次の1件」を原子的に自分の担当にする (プル型分配)。
// 毎日200登録×スタッフ10名の規模では、一覧から目視で選んで claim する方式だと
// 選んでいる間に他のスタッフと衝突する。ここでは候補を上位数件取り、
// 楽観ロック付き UPDATE を先頭から順に試すことで、同時に押した2人が
// 別々のチャットを取れるようにする (自動ラウンドロビンは在席管理が必要に
// なるため採用しない — 在席者しか取らないプル型が構造的に安全)。
// 優先順: lead_temperature (hot→warm→cold→なし) → 最古の未返信 incoming。
chats.post('/api/chats/claim-next', async (c) => {
  try {
    const staffId = persistableStaffId(c.get('staff'));
    if (!staffId) {
      return c.json(
        { success: false, error: 'スタッフとしてログインしてください (共有 API キーでは担当者になれません)' },
        400,
      );
    }

    // unanswered-inbox.ts の CANDIDATES_SQL と同じ「未返信 incoming がある」判定に
    // 「未割当 (chats 行が無い場合も含む)」を重ねた専用クエリ。bind 変数ゼロ。
    const candidates = await c.env.DB
      .prepare(
        `WITH agg AS (
           SELECT friend_id,
             MAX(CASE WHEN direction='incoming' AND (source IS NULL OR source != 'postback') THEN created_at END) AS last_incoming,
             MAX(CASE WHEN direction='outgoing' AND source='manual' THEN created_at END) AS last_manual
           FROM messages_log
           GROUP BY friend_id
         ),
         latest_chat AS (
           SELECT friend_id, id AS chat_id, status, operator_id, version, MAX(created_at) AS created_at
           FROM chats
           GROUP BY friend_id
         )
         SELECT f.id AS friend_id
         FROM friends f
         JOIN agg ON agg.friend_id = f.id
         LEFT JOIN latest_chat lc ON lc.friend_id = f.id
         LEFT JOIN line_accounts la ON la.id = f.line_account_id
         WHERE f.is_following = 1
           AND (la.id IS NULL OR la.is_active = 1)
           AND agg.last_incoming IS NOT NULL
           AND (agg.last_manual IS NULL OR agg.last_manual < agg.last_incoming)
           AND COALESCE(lc.status, 'unread') != 'resolved'
           AND lc.operator_id IS NULL
         ORDER BY
           CASE f.lead_temperature WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END,
           agg.last_incoming ASC
         LIMIT 5`,
      )
      .all<{ friend_id: string }>();

    const now = jstNow();
    for (const candidate of candidates.results) {
      // chats 行が無い友だちはここで遅延作成される
      const chat = await resolveOrCreateChat(c.env.DB, candidate.friend_id);
      if (!chat || chat.operator_id !== null) continue; // 直前に他のスタッフが取った

      const applied = await updateChat(
        c.env.DB,
        chat.id,
        {
          operatorId: staffId,
          assignedAt: now,
          ...(chat.status === 'unread' ? { status: 'in_progress' } : {}),
        },
        { expectedVersion: chat.version },
      );
      if (!applied) continue; // version 競合 → 次候補へ (同時押しのもう一人が勝った)

      return c.json({
        success: true,
        data: { id: chat.friend_id, friendId: chat.friend_id, operatorId: staffId },
      });
    }

    // キューが空 (未割当の未対応が無い)
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('POST /api/chats/claim-next error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 担当を外して未割当に戻す。自分の担当は誰でも外せる。他人の担当を外せるのは
// admin/owner のみ (現場スタッフが誤って他人の担当を剥がす事故を防ぐ)。
chats.post('/api/chats/:id/release', async (c) => {
  try {
    const current = c.get('staff');
    const staffId = persistableStaffId(current);
    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    if (chat.operator_id === null) {
      return c.json({ success: false, error: 'Not assigned' }, 400);
    }

    const isPrivileged = current?.role === 'owner' || current?.role === 'admin';
    if (chat.operator_id !== staffId && !isPrivileged) {
      return c.json({ success: false, error: '他のスタッフの担当は外せません' }, 403);
    }

    const applied = await updateChat(
      c.env.DB,
      chat.id,
      {
        operatorId: null,
        assignedAt: null,
        // 対応中のまま未割当に戻すとキューから見えなくなるため未読へ戻す
        ...(chat.status === 'in_progress' ? { status: 'unread' } : {}),
      },
      { expectedVersion: chat.version },
    );
    if (!applied) return c.json({ success: false, error: 'Version conflict' }, 409);

    return c.json({ success: true, data: { id: chat.friend_id, friendId: chat.friend_id, operatorId: null } });
  } catch (err) {
    console.error('POST /api/chats/:id/release error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 任意のスタッフへ割り当てる (再割当含む)。担当の押し付けになるため
// admin/owner 限定。割当先は実在かつ有効なスタッフのみ。
chats.post('/api/chats/:id/assign', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req.json<{ staffId?: string }>().catch(() => ({}) as { staffId?: string });
    const targetStaffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
    if (!targetStaffId) return c.json({ success: false, error: 'staffId is required' }, 400);

    const target = await getStaffById(c.env.DB, targetStaffId);
    if (!target || !target.is_active) {
      return c.json({ success: false, error: '割当先のスタッフが見つからないか無効です' }, 404);
    }

    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id')!);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    const now = jstNow();
    const applied = await updateChat(
      c.env.DB,
      chat.id,
      {
        operatorId: targetStaffId,
        assignedAt: now,
        ...(chat.status === 'unread' ? { status: 'in_progress' } : {}),
      },
      { expectedVersion: chat.version },
    );
    if (!applied) return c.json({ success: false, error: 'Version conflict' }, 409);

    // 送信 Webhook / 自動化から「担当が付いた」ことを購読できるようにする
    await fireEvent(
      c.env.DB,
      'chat_assigned',
      { friendId: chat.friend_id, eventData: { operatorId: targetStaffId, operatorName: target.name } },
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
      null,
    );

    return c.json({
      success: true,
      data: { id: chat.friend_id, friendId: chat.friend_id, operatorId: targetStaffId },
    });
  } catch (err) {
    console.error('POST /api/chats/:id/assign error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// スヌーズ (再連絡予約)。until を設定すると status='waiting_reply' になり、
// 期限を過ぎると cron (index.ts の releaseExpiredSnoozes) が unread に戻して
// 再浮上させる (担当は維持)。until: null で解除。
chats.post('/api/chats/:id/snooze', async (c) => {
  try {
    const body = await c.req
      .json<{ until?: string | null; expectedVersion?: number }>()
      .catch(() => ({}) as { until?: string | null; expectedVersion?: number });

    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id')!);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    if (body.until === null) {
      // スヌーズ解除。status は waiting_reply のまま残す (手動で変えられる)
      const applied = await updateChat(c.env.DB, chat.id, { snoozeUntil: null }, {
        expectedVersion: body.expectedVersion,
      });
      if (!applied) return c.json({ success: false, error: 'Version conflict' }, 409);
      return c.json({ success: true, data: { id: chat.friend_id, friendId: chat.friend_id, snoozeUntil: null } });
    }

    const until = typeof body.until === 'string' ? body.until : '';
    const untilMs = Date.parse(until);
    if (!until || Number.isNaN(untilMs)) {
      return c.json({ success: false, error: 'until must be an ISO 8601 datetime or null' }, 400);
    }
    if (untilMs <= Date.now()) {
      return c.json({ success: false, error: 'until must be in the future' }, 400);
    }

    const applied = await updateChat(
      c.env.DB,
      chat.id,
      { snoozeUntil: until, status: 'waiting_reply' },
      { expectedVersion: body.expectedVersion },
    );
    if (!applied) return c.json({ success: false, error: 'Version conflict' }, 409);

    return c.json({ success: true, data: { id: chat.friend_id, friendId: chat.friend_id, snoozeUntil: until } });
  } catch (err) {
    console.error('POST /api/chats/:id/snooze error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 内部メモ (時系列・追記専用)。
// 複数スタッフが同時対応する運用では、上書き式の 1 枚メモは「書いた端から
// 消し合う」事故になる。誰が・いつ・何を書いたかを残す。
chats.get('/api/chats/:id/notes', async (c) => {
  try {
    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    const notes = await listChatNotes(c.env.DB, chat.id);
    return c.json({
      success: true,
      data: notes.map((n) => ({
        id: n.id,
        content: n.content,
        createdAt: n.created_at,
        staffId: n.staff_id,
        staffName: n.staff_name,
      })),
    });
  } catch (err) {
    console.error('GET /api/chats/:id/notes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/notes', async (c) => {
  try {
    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    const body = await c.req.json<{ content?: string }>();
    const content = body.content?.trim();
    if (!content) return c.json({ success: false, error: 'content is required' }, 400);

    const note = await createChatNote(c.env.DB, {
      chatId: chat.id,
      staffId: persistableStaffId(c.get('staff')),
      content,
    });

    return c.json({
      success: true,
      data: {
        id: note.id,
        content: note.content,
        createdAt: note.created_at,
        staffId: note.staff_id,
        staffName: note.staff_name,
      },
    });
  } catch (err) {
    console.error('POST /api/chats/:id/notes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { chats };
