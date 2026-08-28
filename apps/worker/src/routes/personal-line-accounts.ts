import { Hono } from 'hono';
import {
  getPersonalLineAccounts,
  getPersonalLineAccountById,
  createPersonalLineAccount,
  updatePersonalLineAccount,
  deletePersonalLineAccount,
} from '@line-crm/db';
import type { PersonalLineAccount } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

const personalLineAccounts = new Hono<Env>();

// bridge_secret / inbound_secret は秘匿。ブリッジ設定に必要なので値は返すが、
// これは owner 専用APIであり、ブリッジ側の設定にそのまま貼り付ける前提。
// (Telegram の bot_token を伏せるのとは異なり、ここは"接続情報の配布"が目的)
function serialize(row: PersonalLineAccount, workerUrl?: string) {
  const base = (workerUrl ?? '').replace(/\/$/, '');
  return {
    id: row.id,
    name: row.name,
    bridgeBaseUrl: row.bridge_base_url,
    isActive: Boolean(row.is_active),
    displayOrder: row.display_order,
    // ブリッジ設定用: 受信Webフック URL とシークレット
    webhookUrl: base ? `${base}/api/personal-line/webhook/${row.id}` : null,
    inboundSecret: row.inbound_secret,
    bridgeSecret: row.bridge_secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET 一覧 (owner/admin/staff)
personalLineAccounts.get(
  '/api/personal-line-accounts',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const rows = await getPersonalLineAccounts(c.env.DB);
    return c.json({ success: true, data: rows.map((r) => serialize(r, c.env.WORKER_URL)) });
  },
);

// POST 作成 (owner のみ)。secret は自動生成する。
personalLineAccounts.post('/api/personal-line-accounts', requireRole('owner'), async (c) => {
  const body = await c.req
    .json<{ name?: string; bridgeBaseUrl?: string | null }>()
    .catch(() => ({} as Record<string, never>));
  const name = (body.name ?? '').trim();
  if (!name) {
    return c.json({ success: false, error: 'name は必須です' }, 400);
  }
  // 十分な長さの乱数を自動生成 (漏洩で受信偽装/送信なりすましが可能なため)
  const bridgeSecret = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  const inboundSecret = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');

  const account = await createPersonalLineAccount(c.env.DB, {
    name,
    bridgeBaseUrl: body.bridgeBaseUrl ?? null,
    bridgeSecret,
    inboundSecret,
  });

  return c.json({ success: true, data: { account: serialize(account, c.env.WORKER_URL) } });
});

// PUT 更新 (owner のみ)
personalLineAccounts.put('/api/personal-line-accounts/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id')!;
  const existing = await getPersonalLineAccountById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'not found' }, 404);

  const body = await c.req
    .json<{ name?: string; bridgeBaseUrl?: string | null; isActive?: boolean }>()
    .catch(() => ({} as Record<string, never>));

  const updated = await updatePersonalLineAccount(c.env.DB, id, {
    name: body.name,
    bridgeBaseUrl: body.bridgeBaseUrl,
    isActive: body.isActive,
  });

  return c.json({
    success: true,
    data: { account: updated ? serialize(updated, c.env.WORKER_URL) : null },
  });
});

// POST ブリッジ疎通テスト (owner のみ) — bridge_base_url に ping を投げて結果を返す。
personalLineAccounts.post(
  '/api/personal-line-accounts/:id/test-bridge',
  requireRole('owner'),
  async (c) => {
    const id = c.req.param('id')!;
    const account = await getPersonalLineAccountById(c.env.DB, id);
    if (!account) return c.json({ success: false, error: 'not found' }, 404);
    const base = (account.bridge_base_url ?? '').replace(/\/$/, '');
    if (!base) return c.json({ success: false, error: 'bridge_base_url 未設定' }, 400);
    let ok = false;
    let status = 0;
    try {
      const res = await fetch(`${base}/health`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${account.bridge_secret}` },
      });
      status = res.status;
      ok = res.ok;
    } catch (err) {
      console.error('[personal-line] bridge test error:', err);
    }
    return c.json({ success: true, data: { reachable: ok, status } });
  },
);

// DELETE (owner のみ)
personalLineAccounts.delete('/api/personal-line-accounts/:id', requireRole('owner'), async (c) => {
  await deletePersonalLineAccount(c.env.DB, c.req.param('id')!);
  return c.json({ success: true });
});

export { personalLineAccounts };
