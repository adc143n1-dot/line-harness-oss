import { Hono } from 'hono';
import { requireRole } from '../middleware/role-guard.js';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

const emergency = new Hono<Env>();

// 緊急コントロール画面専用の一括操作。
//
// これらは元々、管理画面が /api/broadcasts・/api/scenarios の一覧を取得し、
// 対象を絞り込んで1件ずつ PUT する形で実装されていた。その汎用 PUT
// エンドポイントには (通常の個別編集を staff にも許可するため) ロール制限が
// 無く、結果として「全配信停止」「シナリオ一括停止」も staff 権限のまま
// 実行できてしまっていた。会社全体の配信・自動化を止める操作なので、
// 個別編集とは別に owner/admin 限定の専用エンドポイントを設け、
// サーバー側で一括 UPDATE する (原子的・監査しやすい・部分失敗が
// Promise.allSettled の裏に隠れない)。

emergency.post('/api/emergency/stop-broadcasts', requireRole('owner', 'admin'), async (c) => {
  try {
    const result = await c.env.DB
      .prepare(`UPDATE broadcasts SET scheduled_at = NULL, status = 'draft' WHERE status = 'scheduled'`)
      .run();
    return c.json({ success: true, data: { stopped: result.meta?.changes ?? 0 } });
  } catch (err) {
    console.error('POST /api/emergency/stop-broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

emergency.post('/api/emergency/stop-scenarios', requireRole('owner', 'admin'), async (c) => {
  try {
    const result = await c.env.DB
      .prepare(`UPDATE scenarios SET is_active = 0, updated_at = ? WHERE is_active = 1`)
      .bind(jstNow())
      .run();
    return c.json({ success: true, data: { stopped: result.meta?.changes ?? 0 } });
  } catch (err) {
    console.error('POST /api/emergency/stop-scenarios error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { emergency };
