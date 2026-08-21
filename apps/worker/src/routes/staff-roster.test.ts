import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthenticatedStaff } from '../middleware/auth.js';
import type { Env } from '../index.js';

vi.mock('@line-crm/db', () => ({
  getStaffMembers: vi.fn(async () => [
    {
      id: 'staff-1', name: 'Aoi', email: 'aoi@example.com', role: 'staff',
      api_key: 'lh_secret_key_1234', is_active: 1,
      created_at: '2026-08-01T00:00:00.000+09:00', updated_at: '2026-08-01T00:00:00.000+09:00',
    },
    {
      id: 'staff-2', name: 'Ren', email: null, role: 'admin',
      api_key: 'lh_secret_key_5678', is_active: 0,
      created_at: '2026-08-02T00:00:00.000+09:00', updated_at: '2026-08-02T00:00:00.000+09:00',
    },
  ]),
  getStaffById: vi.fn(),
  createStaffMember: vi.fn(),
  updateStaffMember: vi.fn(),
  deleteStaffMember: vi.fn(),
  regenerateStaffApiKey: vi.fn(),
  countActiveStaffByRole: vi.fn(),
}));

import { staff } from './staff.js';

function get(currentStaff: AuthenticatedStaff) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', currentStaff);
    await next();
  });
  app.route('/', staff);
  return app.request('/api/staff/roster', {}, { DB: {} } as unknown as Env['Bindings']);
}

describe('GET /api/staff/roster — 担当者名の解決用名簿', () => {
  test('staff ロールでも取得できる (owner限定の /api/staff と違い担当者名解決に全員が使える)', async () => {
    const res = await get({ id: 'staff-1', name: 'Aoi', role: 'staff' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<Record<string, unknown>> };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  test('返却フィールドは id / name / isActive の3つだけ (APIキー・メール・ロールを漏らさない)', async () => {
    const res = await get({ id: 'staff-1', name: 'Aoi', role: 'staff' });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual(['id', 'isActive', 'name']);
    }
    expect(body.data[0]).toEqual({ id: 'staff-1', name: 'Aoi', isActive: true });
    expect(body.data[1]).toEqual({ id: 'staff-2', name: 'Ren', isActive: false });
  });

  test('レスポンス全体に api_key の断片が含まれない', async () => {
    const res = await get({ id: 'staff-1', name: 'Aoi', role: 'staff' });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('lh_secret');
    expect(text).not.toContain('example.com');
  });
});
