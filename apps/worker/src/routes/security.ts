import { Hono } from 'hono';
import { getAdminIpAllowlist, setAdminIpAllowlist } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { normalizeEntries, ipMatchesAny } from '../lib/ip-allowlist.js';
import type { Env } from '../index.js';

const security = new Hono<Env>();

// 管理画面アクセスのIP許可リスト。owner のみ閲覧・変更可。
// 保存は締め出し防止のため「現在アクセス中のIPを含まない有効化」を拒否する。

// GET /api/security/ip-allowlist → { config, currentIp }
security.get('/api/security/ip-allowlist', requireRole('owner'), async (c) => {
  const config = await getAdminIpAllowlist(c.env.DB);
  const currentIp = c.req.header('CF-Connecting-IP') || null;
  return c.json({ success: true, data: { config, currentIp } });
});

// PUT /api/security/ip-allowlist
// Body: { enabled: boolean, entries: string[] }
security.put('/api/security/ip-allowlist', requireRole('owner'), async (c) => {
  const body = await c.req
    .json<{ enabled?: boolean; entries?: unknown }>()
    .catch((): { enabled?: boolean; entries?: unknown } => ({}));

  const enabled = body.enabled === true;
  const rawEntries = Array.isArray(body.entries)
    ? body.entries.filter((e): e is string => typeof e === 'string')
    : [];

  const { entries, invalid } = normalizeEntries(rawEntries);
  if (invalid.length > 0) {
    return c.json(
      { success: false, error: `不正なIP/CIDRです: ${invalid.join(', ')}` },
      400,
    );
  }

  const currentIp = c.req.header('CF-Connecting-IP') || '';

  if (enabled) {
    if (entries.length === 0) {
      return c.json(
        { success: false, error: '有効にするには、許可するIP/範囲を1件以上指定してください' },
        400,
      );
    }
    // 締め出し防止: 有効化する許可リストに、いま操作している自分のIPが含まれて
    // いなければ拒否する (バイパス env が立っている場合は現在IPが不定なのでスキップ)。
    const bypass = c.env.ADMIN_IP_ALLOWLIST_BYPASS === 'true';
    if (!bypass && (!currentIp || !ipMatchesAny(currentIp, entries))) {
      return c.json(
        {
          success: false,
          error: `この内容だと現在のIP (${currentIp || '不明'}) から締め出されます。現在のIPを含む範囲を追加してください。`,
        },
        400,
      );
    }
  }

  await setAdminIpAllowlist(c.env.DB, { enabled, entries });
  return c.json({ success: true, data: { config: { enabled, entries }, currentIp: currentIp || null } });
});

export { security };
