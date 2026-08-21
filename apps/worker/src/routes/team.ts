import { Hono } from 'hono';
import { jstNow, getAccountSetting, setAccountSetting } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';
import { getAllUnansweredRows } from '../services/unanswered-inbox.js';

const GLOBAL_SCOPE = '__global__';
const TARGET_FIRST_RESPONSE_KEY = 'team_target_first_response_minutes';
const TARGET_DAILY_RESOLVED_KEY = 'team_target_daily_resolved';

// チーム全体の担当状況ダッシュボード (毎日200登録×スタッフ10名規模の運用向け)。
// 「誰が何件持っていて、未割当が何件溜まっているか」を1画面で見るためのAPI。
// 誰が忙しいかは全スタッフに見えた方が「次を取る」判断に役立つため、
// ロール制限は付けない (認証は既存の authMiddleware が担保)。
const team = new Hono<Env>();

interface StaffCountRow {
  operator_id: string;
  status: string;
  cnt: number;
}

interface ResolvedTodayRow {
  operator_id: string;
  cnt: number;
}

interface AvgFirstResponseRow {
  operator_id: string;
  avg_minutes: number | null;
}

team.get('/api/team/overview', async (c) => {
  try {
    const db = c.env.DB;
    const now = jstNow(); // '2026-08-22T12:34:56.789+09:00'
    const todayStartJst = `${now.slice(0, 10)}T00:00:00.000+09:00`;
    const sevenDaysAgoJst = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      openCounts, resolvedToday, avgFirstResponse, hotUnassigned, unansweredRows,
      conversion30d, dailyResolved14d, targetFirstResponseRaw, targetDailyResolvedRaw,
    ] = await Promise.all([
        // 担当者別×状態別の未完了数 (078 の idx_chats_operator_status が効く)
        db
          .prepare(
            `SELECT operator_id, status, COUNT(*) AS cnt
               FROM chats
              WHERE operator_id IS NOT NULL AND status != 'resolved'
              GROUP BY operator_id, status`,
          )
          .all<StaffCountRow>(),
        // 本日 (JST) 解決数
        db
          .prepare(
            `SELECT operator_id, COUNT(*) AS cnt
               FROM chats
              WHERE operator_id IS NOT NULL AND resolved_at >= ?
              GROUP BY operator_id`,
          )
          .bind(todayStartJst)
          .all<ResolvedTodayRow>(),
        // 直近7日の平均初動時間 (担当が付いてから最初の返信までの分数)。
        // assigned_at / first_response_at は書き込み専用だった KPI 列の初活用。
        db
          .prepare(
            `SELECT operator_id,
                    AVG((julianday(first_response_at) - julianday(assigned_at)) * 24 * 60) AS avg_minutes
               FROM chats
              WHERE operator_id IS NOT NULL
                AND assigned_at IS NOT NULL
                AND first_response_at IS NOT NULL
                AND first_response_at >= assigned_at
                AND assigned_at >= ?
              GROUP BY operator_id`,
          )
          .bind(sevenDaysAgoJst)
          .all<AvgFirstResponseRow>(),
        // HOTリードで未割当のまま (副業マッチング)。lc は friend ごとの最新 chats 行
        db
          .prepare(
            `WITH latest_chat AS (
               SELECT friend_id, operator_id, MAX(created_at) AS created_at
               FROM chats GROUP BY friend_id
             )
             SELECT COUNT(*) AS cnt
               FROM friends f
               LEFT JOIN latest_chat lc ON lc.friend_id = f.id
              WHERE f.is_following = 1
                AND f.lead_temperature = 'hot'
                AND lc.operator_id IS NULL`,
          )
          .first<{ cnt: number }>(),
        // 未対応の全行 (operatorId 付き)。判定ロジックは未対応インボックスと同一。
        getAllUnansweredRows(db),
        // 直近30日の成約率 (担当者別: 解決数と、そのうち outcome=converted の数)
        db
          .prepare(
            `SELECT operator_id,
                    COUNT(*) AS resolved_cnt,
                    SUM(CASE WHEN outcome = 'converted' THEN 1 ELSE 0 END) AS converted_cnt
               FROM chats
              WHERE operator_id IS NOT NULL
                AND resolved_at >= datetime('now', '-30 days', '+9 hours')
              GROUP BY operator_id`,
          )
          .all<{ operator_id: string; resolved_cnt: number; converted_cnt: number }>(),
        // 直近14日の日別解決数 (トレンド表示用)。resolved_at はJSTローカル+09:00の
        // ISO文字列なので、date() のUTC変換で日付がずれないよう先頭10文字で切る
        db
          .prepare(
            `SELECT SUBSTR(resolved_at, 1, 10) AS day, COUNT(*) AS cnt
               FROM chats
              WHERE resolved_at >= datetime('now', '-14 days', '+9 hours')
              GROUP BY SUBSTR(resolved_at, 1, 10)
              ORDER BY day ASC`,
          )
          .all<{ day: string; cnt: number }>(),
        getAccountSetting(db, GLOBAL_SCOPE, TARGET_FIRST_RESPONSE_KEY),
        getAccountSetting(db, GLOBAL_SCOPE, TARGET_DAILY_RESOLVED_KEY),
      ]);

    // 担当者別に集計をまとめる
    const byStaff = new Map<
      string,
      {
        unread: number; inProgress: number; waitingReply: number;
        resolvedToday: number; avgFirstResponseMinutes: number | null;
        resolved30d: number; converted30d: number;
      }
    >();
    const ensure = (id: string) => {
      let entry = byStaff.get(id);
      if (!entry) {
        entry = {
          unread: 0, inProgress: 0, waitingReply: 0,
          resolvedToday: 0, avgFirstResponseMinutes: null,
          resolved30d: 0, converted30d: 0,
        };
        byStaff.set(id, entry);
      }
      return entry;
    };
    for (const row of openCounts.results) {
      const entry = ensure(row.operator_id);
      if (row.status === 'unread') entry.unread += row.cnt;
      else if (row.status === 'in_progress') entry.inProgress += row.cnt;
      else if (row.status === 'waiting_reply') entry.waitingReply += row.cnt;
    }
    for (const row of resolvedToday.results) ensure(row.operator_id).resolvedToday = row.cnt;
    for (const row of avgFirstResponse.results) {
      ensure(row.operator_id).avgFirstResponseMinutes =
        row.avg_minutes === null ? null : Math.round(row.avg_minutes * 10) / 10;
    }
    for (const row of conversion30d.results) {
      const entry = ensure(row.operator_id);
      entry.resolved30d = row.resolved_cnt;
      entry.converted30d = row.converted_cnt;
    }

    const unassignedBacklog = unansweredRows.filter((r) => r.operatorId === null).length;

    return c.json({
      success: true,
      data: {
        staff: [...byStaff.entries()].map(([operatorId, v]) => ({ operatorId, ...v })),
        global: {
          totalUnanswered: unansweredRows.length,
          unassignedBacklog,
          hotUnassigned: hotUnassigned?.cnt ?? 0,
        },
        trend: dailyResolved14d.results,
        // Number('') は 0 に化けるため、空文字 (=目標解除) も null 扱いにする
        targets: {
          firstResponseMinutes:
            targetFirstResponseRaw !== null && targetFirstResponseRaw !== '' && Number.isFinite(Number(targetFirstResponseRaw))
              ? Number(targetFirstResponseRaw)
              : null,
          dailyResolved:
            targetDailyResolvedRaw !== null && targetDailyResolvedRaw !== '' && Number.isFinite(Number(targetDailyResolvedRaw))
              ? Number(targetDailyResolvedRaw)
              : null,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/team/overview error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// SLA目標の設定 (admin/owner のみ)。null で目標解除。
team.put('/api/team/targets', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req
      .json<{ firstResponseMinutes?: number | null; dailyResolved?: number | null }>()
      .catch(() => ({}) as { firstResponseMinutes?: number | null; dailyResolved?: number | null });

    const validate = (v: unknown): v is number | null =>
      v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100000);

    if (body.firstResponseMinutes !== undefined) {
      if (!validate(body.firstResponseMinutes)) {
        return c.json({ success: false, error: 'firstResponseMinutes must be a positive number or null' }, 400);
      }
      await setAccountSetting(
        c.env.DB, GLOBAL_SCOPE, TARGET_FIRST_RESPONSE_KEY,
        body.firstResponseMinutes === null ? '' : String(body.firstResponseMinutes),
      );
    }
    if (body.dailyResolved !== undefined) {
      if (!validate(body.dailyResolved)) {
        return c.json({ success: false, error: 'dailyResolved must be a positive number or null' }, 400);
      }
      await setAccountSetting(
        c.env.DB, GLOBAL_SCOPE, TARGET_DAILY_RESOLVED_KEY,
        body.dailyResolved === null ? '' : String(body.dailyResolved),
      );
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('PUT /api/team/targets error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { team };
