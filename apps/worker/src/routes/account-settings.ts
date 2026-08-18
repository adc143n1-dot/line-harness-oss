import { Hono } from 'hono';
import {
  getLinkBaseUrl,
  setLinkBaseUrl,
  getTrackedLinkBaseUrl,
  setTrackedLinkBaseUrl,
} from '@line-crm/db';
import type { Env } from '../index.js';

const accountSettings = new Hono<Env>();

// GET /api/account-settings/test-recipients?accountId=xxx
accountSettings.get('/api/account-settings/test-recipients', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
  ).bind(accountId).first<{ value: string }>();

  const friendIds: string[] = row ? JSON.parse(row.value) : [];

  if (friendIds.length === 0) {
    return c.json({ success: true, data: [] });
  }
  const placeholders = friendIds.map(() => '?').join(',');
  const friends = await c.env.DB.prepare(
    `SELECT id, display_name, picture_url FROM friends WHERE id IN (${placeholders})`
  ).bind(...friendIds).all<{ id: string; display_name: string; picture_url: string | null }>();

  return c.json({
    success: true,
    data: friends.results.map(f => ({
      id: f.id,
      displayName: f.display_name,
      pictureUrl: f.picture_url,
    })),
  });
});

// PUT /api/account-settings/test-recipients
accountSettings.put('/api/account-settings/test-recipients', async (c) => {
  const body = await c.req.json<{ accountId: string; friendIds: string[] }>();
  if (!body.accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');

  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, 'test_recipients', ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`
  ).bind(
    id, body.accountId, JSON.stringify(body.friendIds), now, now,
    JSON.stringify(body.friendIds), now,
  ).run();

  return c.json({ success: true });
});

// ── link_base_url (global setting, stored under sentinel '__global__') ─────────

/**
 * GET /api/account-settings/link-base-url
 * Returns the configured short-link base URL (or null if not set).
 */
accountSettings.get('/api/account-settings/link-base-url', async (c) => {
  const value = await getLinkBaseUrl(c.env.DB, '__global__');
  return c.json({ success: true, data: value });
});

/**
 * PUT /api/account-settings/link-base-url
 * Body: { value: string }
 * - Empty string clears the setting.
 * - Must start with https:// (if non-empty).
 * - Trailing slash is stripped before saving.
 */
accountSettings.put('/api/account-settings/link-base-url', async (c) => {
  const body = await c.req
    .json<{ value?: string }>()
    .catch((): { value?: string } => ({}));
  const value = typeof body.value === 'string' ? body.value : '';

  try {
    await setLinkBaseUrl(c.env.DB, '__global__', value);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation error';
    return c.json({ success: false, error: message }, 400);
  }
});

// ── tracked_link_base_url (global setting) ────────────────────────────────────
// Base domain for message tracked links (/t/<code>). The domain must route
// /t/* to the Worker (Redirect Rule or Custom Domain). Unset → WORKER_URL.

accountSettings.get('/api/account-settings/tracked-link-base-url', async (c) => {
  const value = await getTrackedLinkBaseUrl(c.env.DB, '__global__');
  return c.json({ success: true, data: value });
});

accountSettings.put('/api/account-settings/tracked-link-base-url', async (c) => {
  const body = await c.req
    .json<{ value?: string }>()
    .catch((): { value?: string } => ({}));
  const value = typeof body.value === 'string' ? body.value : '';

  try {
    await setTrackedLinkBaseUrl(c.env.DB, '__global__', value);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation error';
    return c.json({ success: false, error: message }, 400);
  }
});


// ── ai_reply_enabled / ai_reply_daily_limit (アカウント別、account_settings に相乗り) ─
//
// マスタースイッチは env.AI_REPLY_ENABLED (未設定なら常に無効・フェイルセーフ)。
// ここでの設定はマスタースイッチが ON の場合の「アカウント別オプトアウト」と
// 「1日あたりの送信上限」。マスターを ON にしただけでは全アカウント有効の
// ままになる (既存挙動を変えない)。

accountSettings.get('/api/account-settings/ai-reply-enabled', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'ai_reply_enabled'`,
  ).bind(accountId).first<{ value: string }>();

  // 未設定 = 上位設定 (マスタースイッチ) に従う、を意味するので null を返す
  return c.json({ success: true, data: row ? row.value === 'true' : null });
});

accountSettings.put('/api/account-settings/ai-reply-enabled', async (c) => {
  const body = await c.req
    .json<{ accountId?: string; enabled?: boolean | null }>()
    .catch((): { accountId?: string; enabled?: boolean | null } => ({}));
  if (!body.accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  if (body.enabled === null || body.enabled === undefined) {
    // 明示的に「上位設定に従う」へ戻す
    await c.env.DB.prepare(
      `DELETE FROM account_settings WHERE line_account_id = ? AND key = 'ai_reply_enabled'`,
    ).bind(body.accountId).run();
    return c.json({ success: true });
  }

  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  const value = body.enabled ? 'true' : 'false';
  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, 'ai_reply_enabled', ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
  ).bind(id, body.accountId, value, now, now, value, now).run();

  return c.json({ success: true });
});

accountSettings.get('/api/account-settings/ai-reply-daily-limit', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'ai_reply_daily_limit'`,
  ).bind(accountId).first<{ value: string }>();

  return c.json({ success: true, data: row ? Number(row.value) : null });
});

accountSettings.put('/api/account-settings/ai-reply-daily-limit', async (c) => {
  const body = await c.req
    .json<{ accountId?: string; limit?: number | null }>()
    .catch((): { accountId?: string; limit?: number | null } => ({}));
  if (!body.accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  if (body.limit === null || body.limit === undefined) {
    await c.env.DB.prepare(
      `DELETE FROM account_settings WHERE line_account_id = ? AND key = 'ai_reply_daily_limit'`,
    ).bind(body.accountId).run();
    return c.json({ success: true });
  }
  if (!Number.isInteger(body.limit) || body.limit < 0) {
    return c.json({ success: false, error: 'limit must be a non-negative integer' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  const value = String(body.limit);
  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, 'ai_reply_daily_limit', ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
  ).bind(id, body.accountId, value, now, now, value, now).run();

  return c.json({ success: true });
});

// 可視化: 直近の AI 応答送信数。messages_log.source='ai_reply' を実測として
// 集計する (専用のカウンターテーブルは持たない — 二重管理を避けるため)。
accountSettings.get('/api/account-settings/ai-reply-stats', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const todayPrefix = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() + 9 * 60 * 60_000 - 7 * 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);

  const [today, last7Days] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages_log WHERE source = 'ai_reply' AND line_account_id = ? AND created_at LIKE ?`,
    ).bind(accountId, `${todayPrefix}%`).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages_log WHERE source = 'ai_reply' AND line_account_id = ? AND created_at >= ?`,
    ).bind(accountId, sevenDaysAgo).first<{ n: number }>(),
  ]);

  return c.json({ success: true, data: { today: today?.n ?? 0, last7Days: last7Days?.n ?? 0 } });
});

export { accountSettings };
