import { getAccountSetting, setAccountSetting, jstNow } from '@line-crm/db';
import { AnthropicProvider } from './ai-reply/index.js';
import { getAllUnansweredRows } from './unanswered-inbox.js';

// AIアドバイザー (運用監視と改善提案)。
//
// 運用スナップショット (チーム状況・リード・未対応・自動化の稼働状況・
// 頻出の未対応メッセージ) を集めて Claude に渡し、「今すぐ直すべきこと /
// 自動化できること / うまくいっていること」の所見を日本語で返してもらう。
//
// コスト設計:
// - 手動分析 (POST /api/advisor/analyze) は「ボタンを押した時だけ」課金される
//   明示的な操作なので、AI自動応答のマスタースイッチ (AI_REPLY_ENABLED) とは
//   独立に、ANTHROPIC_API_KEY があれば実行できる
// - 週次の自動分析は advisor_weekly_enabled ('__global__' KV) を 'true' に
//   した場合のみ動く明示的オプトイン (黙って毎週課金しない)
// - 結果は account_settings にキャッシュし、次の分析まで何度でも無料で読める

const GLOBAL_SCOPE = '__global__';
const REPORT_KEY = 'advisor_last_report';
const WEEKLY_ENABLED_KEY = 'advisor_weekly_enabled';
const WEEKLY_LAST_AT_KEY = 'advisor_last_weekly_at';

export interface AdvisorEnv {
  ANTHROPIC_API_KEY?: string;
  AI_REPLY_MODEL?: string;
}

export interface AdvisorReport {
  generatedAt: string;
  trigger: 'manual' | 'weekly';
  content: string;
}

interface CountRow { k: string | null; cnt: number }

/** 運用スナップショットを集めて、プロンプトに入れる要約テキストを作る */
export async function buildOperationsSnapshot(db: D1Database): Promise<string> {
  const [staffCounts, resolved7d, leads, automationInventory, repeatedManual, unanswered] =
    await Promise.all([
      db.prepare(
        `SELECT operator_id AS k, COUNT(*) AS cnt FROM chats
          WHERE operator_id IS NOT NULL AND status != 'resolved' GROUP BY operator_id`,
      ).all<CountRow>(),
      db.prepare(
        `SELECT operator_id AS k, COUNT(*) AS cnt FROM chats
          WHERE resolved_at >= datetime('now', '-7 days', '+9 hours') AND operator_id IS NOT NULL
          GROUP BY operator_id`,
      ).all<CountRow>(),
      db.prepare(
        `SELECT COALESCE(lead_temperature, 'none') AS k, COUNT(*) AS cnt FROM friends
          WHERE job_matching_conversation_state IS NOT NULL GROUP BY lead_temperature`,
      ).all<CountRow>(),
      db.prepare(
        `SELECT 'scenarios_active' AS k, COUNT(*) AS cnt FROM scenarios WHERE is_active = 1
         UNION ALL SELECT 'scenarios_inactive', COUNT(*) FROM scenarios WHERE is_active = 0
         UNION ALL SELECT 'auto_replies_active', COUNT(*) FROM auto_replies WHERE is_active = 1
         UNION ALL SELECT 'automations_active', COUNT(*) FROM automations WHERE is_active = 1
         UNION ALL SELECT 'broadcasts_sent_30d', COUNT(*) FROM broadcasts WHERE status = 'sent' AND sent_at >= datetime('now', '-30 days', '+9 hours')`,
      ).all<CountRow>(),
      // スタッフが手動で3回以上送った同一文面 → テンプレ化/自動返信化の候補
      db.prepare(
        `SELECT SUBSTR(content, 1, 120) AS k, COUNT(*) AS cnt FROM messages_log
          WHERE direction = 'outgoing' AND source = 'manual' AND message_type = 'text'
            AND created_at >= datetime('now', '-30 days', '+9 hours')
          GROUP BY content HAVING COUNT(*) >= 3
          ORDER BY cnt DESC LIMIT 8`,
      ).all<CountRow>(),
      getAllUnansweredRows(db),
    ]);

  const unassigned = unanswered.filter((r) => r.operatorId === null).length;
  const oldestWaitMin = unanswered.length > 0
    ? Math.round((Date.now() - new Date(unanswered[unanswered.length - 1].lastIncomingAt).getTime()) / 60000)
    : 0;
  // 未対応の実メッセージ (最新20件・冒頭80文字)。FAQ傾向の推定材料
  const unansweredSamples = unanswered.slice(0, 20).map((r) => r.lastIncomingContent.slice(0, 80));

  const lines: string[] = [
    `# 現在の運用データ (${jstNow()})`,
    `## チーム`,
    `- スタッフ別の未完了担当数: ${JSON.stringify(Object.fromEntries(staffCounts.results.map((r) => [r.k, r.cnt])))}`,
    `- スタッフ別の直近7日解決数: ${JSON.stringify(Object.fromEntries(resolved7d.results.map((r) => [r.k, r.cnt])))}`,
    `- 未対応(人間の返事待ち): ${unanswered.length}件 / うち担当未割当: ${unassigned}件 / 最長待ち: ${oldestWaitMin}分`,
    `## リード (副業マッチング診断)`,
    `- 温度別: ${JSON.stringify(Object.fromEntries(leads.results.map((r) => [r.k, r.cnt])))}`,
    `## 自動化の稼働状況`,
    ...automationInventory.results.map((r) => `- ${r.k}: ${r.cnt}`),
    `## スタッフが手動で繰り返し送っている文面 (回数付き、自動化候補)`,
    ...(repeatedManual.results.length > 0
      ? repeatedManual.results.map((r) => `- (${r.cnt}回) ${r.k}`)
      : ['- なし']),
    `## 未対応メッセージのサンプル (FAQ傾向の推定用)`,
    ...(unansweredSamples.length > 0 ? unansweredSamples.map((s) => `- ${s}`) : ['- なし']),
  ];
  return lines.join('\n');
}

const ADVISOR_SYSTEM_PROMPT =
  'あなたはLINE公式アカウント運用チームの運用改善アドバイザーです。' +
  '与えられた運用データだけを根拠に、日本語で簡潔に所見を書いてください。' +
  '出力は必ず次の3見出しのMarkdown: 「## 🚨 今すぐ直すべきこと」「## ⚙️ 自動化できること」「## ✅ うまくいっていること」。' +
  '各見出しの下に最大3項目の箇条書き。各項目は1〜2文で、必ずデータ上の数字を根拠として引用すること。' +
  '該当がない見出しには「特になし」と書く。推測で断定しない。煽り表現や誇張は使わない。';

/** 分析を実行して結果を保存し、レポートを返す */
export async function runAdvisorAnalysis(
  db: D1Database,
  env: AdvisorEnv,
  trigger: 'manual' | 'weekly',
): Promise<AdvisorReport> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const provider = new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_REPLY_MODEL);
  const snapshot = await buildOperationsSnapshot(db);

  const content = await provider.generateReply({
    systemPrompt: ADVISOR_SYSTEM_PROMPT,
    history: [{ role: 'user', content: snapshot }],
    maxTokens: 1200,
  });

  const report: AdvisorReport = { generatedAt: jstNow(), trigger, content };
  await setAccountSetting(db, GLOBAL_SCOPE, REPORT_KEY, JSON.stringify(report));
  return report;
}

/** キャッシュ済みの最新レポート (無ければ null) */
export async function getLastAdvisorReport(db: D1Database): Promise<AdvisorReport | null> {
  const raw = await getAccountSetting(db, GLOBAL_SCOPE, REPORT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdvisorReport;
  } catch {
    return null;
  }
}

export interface AutomationCandidate {
  type: 'repeated_manual_reply' | 'frequent_incoming';
  content: string;
  count: number;
}

/**
 * ルールベースの自動化候補検出 (AI不要・無料)。
 * - 手動で3回以上送られた同一文面 → テンプレート/自動返信化の候補
 * - 3回以上届いた同一の受信文面 → 自動返信ルールの候補
 */
export async function detectAutomationCandidates(db: D1Database): Promise<AutomationCandidate[]> {
  const [manual, incoming] = await Promise.all([
    db.prepare(
      `SELECT content AS k, COUNT(*) AS cnt FROM messages_log
        WHERE direction = 'outgoing' AND source = 'manual' AND message_type = 'text'
          AND created_at >= datetime('now', '-30 days', '+9 hours')
        GROUP BY content HAVING COUNT(*) >= 3
        ORDER BY cnt DESC LIMIT 10`,
    ).all<CountRow>(),
    db.prepare(
      `SELECT content AS k, COUNT(*) AS cnt FROM messages_log
        WHERE direction = 'incoming' AND message_type = 'text'
          AND (source IS NULL OR source != 'postback')
          AND created_at >= datetime('now', '-30 days', '+9 hours')
        GROUP BY content HAVING COUNT(*) >= 3
        ORDER BY cnt DESC LIMIT 10`,
    ).all<CountRow>(),
  ]);

  return [
    ...manual.results
      .filter((r) => r.k)
      .map((r) => ({ type: 'repeated_manual_reply' as const, content: r.k!, count: r.cnt })),
    ...incoming.results
      .filter((r) => r.k)
      .map((r) => ({ type: 'frequent_incoming' as const, content: r.k!, count: r.cnt })),
  ];
}

/**
 * 週次自動分析。advisor_weekly_enabled='true' のときだけ実行する明示的
 * オプトイン。直近7日以内に週次実行済みならスキップ (多重発火防止)。
 * 実行後は fireEvent 側 (呼び出し元) で webhook 配信する。
 */
export async function maybeRunWeeklyAdvisor(
  db: D1Database,
  env: AdvisorEnv,
): Promise<AdvisorReport | null> {
  const enabled = await getAccountSetting(db, GLOBAL_SCOPE, WEEKLY_ENABLED_KEY);
  if (enabled !== 'true') return null;
  if (!env.ANTHROPIC_API_KEY) return null;

  const lastAt = await getAccountSetting(db, GLOBAL_SCOPE, WEEKLY_LAST_AT_KEY);
  if (lastAt && Date.now() - new Date(lastAt).getTime() < 6 * 24 * 60 * 60 * 1000) {
    return null; // 6日以内に実行済み
  }

  const report = await runAdvisorAnalysis(db, env, 'weekly');
  await setAccountSetting(db, GLOBAL_SCOPE, WEEKLY_LAST_AT_KEY, report.generatedAt);
  return report;
}
