import type { Context, Next } from 'hono';
import { getStaffByApiKey, getAdminIpAllowlist } from '@line-crm/db';
import type { Env } from '../index.js';
import type { AdminSameSite } from './admin-auth-config.js';
import { ipMatchesAny } from '../lib/ip-allowlist.js';

export const ADMIN_AUTH_COOKIE = 'lh_admin_session';
export const CSRF_COOKIE = 'lh_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// 7 days, matching the previous localStorage session longevity.
const SESSION_MAX_AGE = 604800;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * decodeURIComponent throws on malformed percent escapes (e.g. `%`). Cookie
 * headers are client-controlled, so fall back to the raw value rather than
 * letting the exception turn a request into a 500.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    cookies[rawName] = safeDecode(rawValue.join('=') || '');
  }
  return cookies;
}

function bearerToken(c: Context<Env>): string | null {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length);
}

function cookieToken(c: Context<Env>): string | null {
  return parseCookieHeader(c.req.header('Cookie'))[ADMIN_AUTH_COOKIE] || null;
}

export function csrfTokenFromCookie(c: Context<Env>): string | null {
  return parseCookieHeader(c.req.header('Cookie'))[CSRF_COOKIE] || null;
}

function buildCookie(
  name: string,
  value: string,
  sameSite: AdminSameSite,
  maxAge: number,
  httpOnly: boolean,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (httpOnly) parts.push('HttpOnly');
  parts.push('Secure', `SameSite=${sameSite}`, `Max-Age=${maxAge}`);
  return parts.join('; ');
}

/** HttpOnly session cookie carrying the API token. */
export function adminSessionCookie(token: string, sameSite: AdminSameSite): string {
  return buildCookie(ADMIN_AUTH_COOKIE, token, sameSite, SESSION_MAX_AGE, true);
}

/**
 * CSRF cookie. NOT HttpOnly so it can participate in double-submit, but in a
 * cross-site topology the SPA cannot read it (different registrable domain) —
 * the token is therefore also returned in the login/session response body and
 * the SPA echoes it via the X-CSRF-Token header. The Worker validates that
 * header against this cookie, which the browser does send back to the API
 * (SameSite=None).
 */
export function csrfCookie(token: string, sameSite: AdminSameSite): string {
  return buildCookie(CSRF_COOKIE, token, sameSite, SESSION_MAX_AGE, false);
}

export function expiredCookie(name: string, sameSite: AdminSameSite): string {
  return buildCookie(name, '', sameSite, 0, name === ADMIN_AUTH_COOKIE);
}

export type AuthenticatedStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
};

/**
 * Synthetic staff id used when the caller authenticated with the env API_KEY
 * (or the legacy rotation key) rather than a staff_members row. It has no
 * matching row, so it must never be written to a column that references
 * staff_members — use persistableStaffId() before persisting.
 */
export const ENV_OWNER_STAFF_ID = 'env-owner';

/**
 * The staff id to persist as an attribution, or null when the caller has no
 * real staff_members row behind them (env key auth, or unauthenticated paths
 * such as automated sends).
 */
export function persistableStaffId(staff: AuthenticatedStaff | undefined | null): string | null {
  if (!staff) return null;
  if (staff.id === ENV_OWNER_STAFF_ID) return null;
  return staff.id;
}

/**
 * Resolve a token (from a Bearer header or the session cookie) to a staff
 * identity. Shared by the auth middleware and the /api/auth/login endpoint so
 * cookie and Bearer auth accept exactly the same credentials.
 */
export async function authenticateApiToken(
  c: Context<Env>,
  token: string | null,
): Promise<AuthenticatedStaff | null> {
  if (!token) return null;

  const staff = await getStaffByApiKey(c.env.DB, token);
  if (staff) {
    return { id: staff.id, name: staff.name, role: staff.role };
  }

  // Fallback: env API_KEY acts as owner (current rotation slot)
  if (token === c.env.API_KEY) {
    return { id: ENV_OWNER_STAFF_ID, name: 'Owner', role: 'owner' };
  }

  // Legacy fallback: LEGACY_API_KEY accepted during rotation grace period.
  // Same-value guard: if both env vars are set to the same secret, the primary
  // check above already accepts it; this branch must skip to avoid false
  // LEGACY counters. Logs accept_via=LEGACY_API_KEY so operators can confirm
  // zero legacy usage before deleting the secret.
  if (
    c.env.LEGACY_API_KEY &&
    c.env.LEGACY_API_KEY !== c.env.API_KEY &&
    token === c.env.LEGACY_API_KEY
  ) {
    console.log('[auth] accept_via=LEGACY_API_KEY');
    return { id: ENV_OWNER_STAFF_ID, name: 'Owner', role: 'owner' };
  }

  return null;
}

/**
 * IP許可リストの enforcement。管理画面(ログイン + 認証必須API)への
 * アクセスを、設定された送信元IP(社内固定IP等)に限定する。
 *
 * - env.ADMIN_IP_ALLOWLIST_BYPASS === 'true' は緊急脱出用の全解除。
 * - 設定が無効 / entries が空なら制限しない (既定)。
 * - 設定読み込みに失敗したときは fail-open (D1 の一時障害で管理画面全体が
 *   ロックされるのを避ける)。ただし設定が読めて IP が一致しない場合は 403。
 * - CF-Connecting-IP は Cloudflare 経由の実クライアントIP。
 *
 * ロックアウト時の復旧: 保存API側で「現在のIPを含まない有効化」を拒否して
 * いるが、万一締め出された場合は D1 を直接編集して解除できる:
 *   wrangler d1 execute <DB> --remote --command \
 *     "DELETE FROM account_settings WHERE line_account_id='__global__' AND key='admin_ip_allowlist'"
 * もしくは env に ADMIN_IP_ALLOWLIST_BYPASS='true' を設定して再デプロイ。
 */
async function enforceAdminIpAllowlist(c: Context<Env>): Promise<Response | null> {
  if (c.env.ADMIN_IP_ALLOWLIST_BYPASS === 'true') return null;

  let config: { enabled: boolean; entries: string[] };
  try {
    config = await getAdminIpAllowlist(c.env.DB);
  } catch {
    return null; // fail-open on transient config-read failure
  }
  if (!config.enabled || config.entries.length === 0) return null;

  const ip = c.req.header('CF-Connecting-IP') || '';
  if (ip && ipMatchesAny(ip, config.entries)) return null;

  return c.json(
    { success: false, error: 'このIPアドレスからは管理画面にアクセスできません' },
    403,
  );
}

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  // Skip auth for the LINE webhook endpoint — it uses signature verification instead
  // Skip auth for OpenAPI docs — public documentation
  const path = new URL(c.req.url).pathname;
  // LIFF / admin の SPA アセットは Authorization ヘッダなしで HTML を取りに
  // くる。Worker は API 以外のパスを ASSETS バインディングから配信するので、
  // /api/ で始まらないパスは認証 skip して static asset として返す。
  // (admin は別ホスト、Worker の non-API path はすべて LIFF/SPA 経由)
  const method = c.req.method.toUpperCase();
  if (!path.startsWith('/api/')) {
    // ただし内部用エンドポイント (/webhook, /auth, /setup) は元の skip 判定に任せる
    if (
      path !== '/webhook' &&
      !path.startsWith('/auth/') &&
      path !== '/setup' &&
      !path.startsWith('/t/') &&
      !path.startsWith('/r/') &&
      !path.startsWith('/pool/') &&
      !path.startsWith('/images/')
    ) {
      return next();
    }
  }

  // A form definition is public because the LIFF client must render it before
  // submission. Authenticate opportunistically so the same GET can still
  // return the full admin representation to SDK/admin callers, while an
  // unauthenticated LIFF caller receives the redacted public representation.
  // Crucially, this exception is method-aware: PUT/DELETE on the same path
  // must continue through the normal admin authentication below.
  const isPublicFormDefinition =
    method === 'GET' && /^\/api\/forms\/[^/]+$/.test(path);
  if (isPublicFormDefinition) {
    const token = bearerToken(c) ?? cookieToken(c);
    const staff = await authenticateApiToken(c, token);
    if (staff) {
      // 認証済み = 管理者向けフル表現を返す経路。ここは他の管理APIと同様に
      // IP許可リストの対象にする (許可外IPからは管理者表現を出さない)。
      // 無認証の LIFF 閲覧者 (token なし) は従来どおり公開表現を受け取る。
      const denied = await enforceAdminIpAllowlist(c);
      if (denied) return denied;
      c.set('staff', staff);
    }
    return next();
  }

  // These LIFF actions perform their own LINE ID-token verification inside
  // the route. They cannot use the admin auth gate because their Bearer token
  // is a LINE ID token, not a Harness staff API key.
  const isPublicFormAction =
    method === 'POST' &&
    (/^\/api\/forms\/[^/]+\/submit$/.test(path) ||
      /^\/api\/forms\/[^/]+\/opened$/.test(path) ||
      /^\/api\/forms\/[^/]+\/partial$/.test(path));
  if (isPublicFormAction) return next();

  // Admin login is in the public skip list below (no session yet), but it is
  // still part of the admin control plane — enforce the IP allowlist here so an
  // off-network caller cannot even attempt to log in with a stolen key.
  if (path === '/api/auth/login') {
    const denied = await enforceAdminIpAllowlist(c);
    if (denied) return denied;
  }

  if (
    path === '/webhook' ||
    path === '/docs' ||
    path === '/openapi.json' ||
    path === '/api/affiliates/click' ||
    path.startsWith('/t/') ||
    path.startsWith('/r/') ||
    path.startsWith('/pool/') ||
    path.startsWith('/images/') ||
    // 画像 src として <img> 経由でブラウザが取得するため (Authorization ヘッダ不可)。
    // R2 key 内に group_id / page_id (UUID) が含まれるので推測困難。draft 画像も
    // 最終的に LINE 上で公開されるため機密性は低い。
    path.startsWith('/api/rich-menu-images/') ||
    // LINE 上 rich menu 画像 proxy (Authorization ヘッダなしで <img src> 経由表示)
    path.match(/^\/api\/rich-menu-groups\/external\/[^/]+\/image$/) ||
    path.startsWith('/api/liff/') ||
    // Admin login/logout — issue/clear the session cookie before auth exists.
    path === '/api/auth/login' ||
    path === '/api/auth/logout' ||
    path.startsWith('/auth/') ||
    path === '/setup' ||
    path === '/api/integrations/stripe/webhook' ||
    // Telegram Bot webhook — 認証ヘッダを付けられないため、代わりに
    // setWebhook の secret_token (X-Telegram-Bot-Api-Secret-Token) を
    // ルート側で検証する。
    path === '/api/telegram/webhook' ||
    path.match(/^\/api\/webhooks\/incoming\/[^/]+\/receive$/) ||
    path === '/api/meet-callback' || // Meet Harness completion callback
    // Google OAuth redirects without admin headers. Route verifies a signed, expiring state.
    (path === '/api/booking/google-calendar/oauth/callback' && method === 'GET') ||
    path === '/api/qr' || // Public QR proxy — used by desktop landing pages
    path === '/api/health' || // Liveness probe (update CLI / self-update verify)
    // Public lead form. Origin validation and field validation happen in-route.
    (path === '/api/public/media-inquiries' && method === 'POST')
  ) {
    return next();
  }

  // Everything from here on is the authenticated admin control plane. Enforce
  // the IP allowlist before authenticating so off-network requests are refused
  // regardless of credentials.
  const ipDenied = await enforceAdminIpAllowlist(c);
  if (ipDenied) return ipDenied;

  const bearer = bearerToken(c);
  const cookie = cookieToken(c);
  const token = bearer ?? cookie;

  const staff = await authenticateApiToken(c, token);
  if (!staff) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  // CSRF protection applies ONLY to cookie-authenticated, state-changing
  // requests. Bearer callers (SDK/MCP) cannot be driven cross-site by a
  // browser (an attacker cannot set the Authorization header), so they are
  // exempt. Safe methods (GET/HEAD/OPTIONS) never mutate, so they are exempt.
  if (!bearer && cookie && !SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const header = c.req.header(CSRF_HEADER);
    const expected = csrfTokenFromCookie(c);
    if (!header || !expected || header !== expected) {
      return c.json({ success: false, error: 'CSRF token mismatch' }, 403);
    }
  }

  c.set('staff', staff);
  return next();
}
