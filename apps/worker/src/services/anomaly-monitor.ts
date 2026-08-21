import { getAccountSetting, setAccountSetting } from '@line-crm/db';
import { countUnanswered, getAllUnansweredRows } from './unanswered-inbox.js';
import { fireEvent } from './event-bus.js';

// 異常検知モニター — ban-monitor.ts と同じ構造 (cronから定期実行、D1集計→
// 閾値判定→アラート) を、指標ごとに別ファイルとして追加する方針。
// notification_rules/notifications テーブルは汎用ルールエンジンとして
// 存在するが未接続の孤児コード (index.ts に「インボックス機能に置き換えた
// ため削除」と明記) であり、これを汎用エンジンとして復活させるのは
// 過剰投資と判断。指標を増やしたくなったら、この型のファイルをもう1つ
// 追加するだけで済むようにしておく。
//
// 対象指標: 未対応バックログの異常増加。大量顧客運用で最も実害が大きい
// 「スタッフが気づかないまま未対応が積み上がる」を直接検知する。

const GLOBAL_SCOPE = '__global__';
const PREV_COUNT_KEY = 'anomaly_unanswered_backlog_prev_count';
const THRESHOLD_KEY = 'anomaly_unanswered_spike_threshold';
const DEFAULT_THRESHOLD = 20;

/**
 * 直近の計測 (通常は1時間おき) と比べて未対応件数がどれだけ増えたかを見る。
 * 増加が閾値以上ならアラートを発火する。専用のログテーブルは持たず、
 * 前回件数は account_settings に1行だけ持たせる (他の設定と同じ再利用
 * パターン)。閾値を超え続ける限り呼び出しのたびに発火する — 「悪化が
 * 続いているなら毎回知りたい」という運用上の実需に合わせ、意図的に
 * 抑制・クールダウンを入れない (AI応答の日次上限アラートとは違い、
 * 「同じ事実の重複通知」ではなく「悪化の継続」を表すため)。
 */
export async function checkUnansweredBacklogSpike(db: D1Database): Promise<void> {
  const current = await countUnanswered(db);

  const [prevRaw, thresholdRaw] = await Promise.all([
    getAccountSetting(db, GLOBAL_SCOPE, PREV_COUNT_KEY),
    getAccountSetting(db, GLOBAL_SCOPE, THRESHOLD_KEY),
  ]);

  await setAccountSetting(db, GLOBAL_SCOPE, PREV_COUNT_KEY, String(current.total));

  if (prevRaw === null) return; // 初回計測はベースラインを記録するだけ

  const previousTotal = Number(prevRaw);
  if (!Number.isFinite(previousTotal)) return;

  // Number(null) は 0 にコアーションされ Number.isFinite(0)===true になるため、
  // 「未設定 (null)」と「明示的に 0 が設定されている」を区別できるよう
  // thresholdRaw !== null を先に見る (Number.isFinite(Number(thresholdRaw))
  // だけだと未設定時に閾値 0 が使われ、あらゆる増加で発火してしまう実バグがあった)。
  const threshold = thresholdRaw !== null && Number.isFinite(Number(thresholdRaw))
    ? Number(thresholdRaw)
    : DEFAULT_THRESHOLD;
  const delta = current.total - previousTotal;
  if (delta < threshold) return;

  await fireEvent(db, 'unanswered_backlog_spike', {
    eventData: {
      previousTotal,
      currentTotal: current.total,
      delta,
      threshold,
      oldestWaitMinutes: current.oldestWaitMinutes,
    },
  });
}

// ─── チーム運用アラート (Phase 4) ───
// プル型キュー運用の弱点は「全員が取り忘れると誰も気づかない」こと。
// 未割当バックログと HOT リード未割当を毎時チェックし、閾値超過で
// 送信 Webhook (fireEvent) へ流す。閾値は他の設定と同じ account_settings
// の '__global__' KV パターン。0 を設定すれば「1件でも溜まったら通知」になる。

const UNASSIGNED_THRESHOLD_KEY = 'team_unassigned_alert_threshold';
const DEFAULT_UNASSIGNED_THRESHOLD = 10;
const HOT_UNASSIGNED_THRESHOLD_KEY = 'team_hot_unassigned_alert_threshold';
const DEFAULT_HOT_UNASSIGNED_THRESHOLD = 1;

/**
 * 「誰も担当していない未対応」が閾値以上溜まっていたらアラートする。
 * spike 検知 (前回比) と違い絶対量で判定する — プル型キューでは
 * 「取り手がいない」状態そのものが異常のため。閾値を超え続ける限り
 * 毎時発火する (悪化の継続を毎回知らせる方針は spike と同じ)。
 */
export async function checkUnassignedBacklog(db: D1Database): Promise<void> {
  const rows = await getAllUnansweredRows(db);
  const unassigned = rows.filter((r) => r.operatorId === null);

  const thresholdRaw = await getAccountSetting(db, GLOBAL_SCOPE, UNASSIGNED_THRESHOLD_KEY);
  const threshold = thresholdRaw !== null && Number.isFinite(Number(thresholdRaw))
    ? Number(thresholdRaw)
    : DEFAULT_UNASSIGNED_THRESHOLD;

  if (unassigned.length < threshold) return;

  const oldest = unassigned.reduce<string | null>(
    (min, r) => (min === null || r.lastIncomingAt < min ? r.lastIncomingAt : min),
    null,
  );
  await fireEvent(db, 'team_unassigned_backlog', {
    eventData: {
      unassignedCount: unassigned.length,
      totalUnanswered: rows.length,
      threshold,
      oldestIncomingAt: oldest,
    },
  });
}

/**
 * HOT リード (副業マッチングで本気度最上位) が未割当のまま放置されていたら
 * アラートする。既定は1件でも発火 — HOT は即日対応が前提のため。
 */
export async function checkHotLeadsUnassigned(db: D1Database): Promise<void> {
  const row = await db
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
    .first<{ cnt: number }>();
  const count = row?.cnt ?? 0;

  const thresholdRaw = await getAccountSetting(db, GLOBAL_SCOPE, HOT_UNASSIGNED_THRESHOLD_KEY);
  const threshold = thresholdRaw !== null && Number.isFinite(Number(thresholdRaw))
    ? Number(thresholdRaw)
    : DEFAULT_HOT_UNASSIGNED_THRESHOLD;

  if (count < threshold) return;

  await fireEvent(db, 'team_hot_leads_unassigned', {
    eventData: { hotUnassignedCount: count, threshold },
  });
}
