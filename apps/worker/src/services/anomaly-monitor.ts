import { getAccountSetting, setAccountSetting } from '@line-crm/db';
import { countUnanswered } from './unanswered-inbox.js';
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
