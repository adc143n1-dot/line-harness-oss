import { jstNow } from './utils.js';

// 副業マッチング自動化システム (Phase A) 用の friends 拡張列ヘルパー。
// 汎用の updateFriend() は存在しない (このリポジトリの慣習として、更新は
// 目的別の専用関数で行う) ため、この機能専用の更新関数をここに置く。

export type JobMatchingConversationState = 'awaiting_q1' | 'awaiting_q2' | 'diagnosed';
export type LeadTemperature = 'hot' | 'warm' | 'cold';

export interface JobMatchingLeadState {
  job_matching_conversation_state: JobMatchingConversationState | null;
  q1_answer: string | null;
  q2_answer: string | null;
  q3_answer: string | null;
  q4_answer: string | null;
  lead_score: number | null;
  lead_temperature: LeadTemperature | null;
}

export async function getJobMatchingLeadState(
  db: D1Database,
  friendId: string,
): Promise<JobMatchingLeadState | null> {
  return db
    .prepare(
      `SELECT job_matching_conversation_state, q1_answer, q2_answer, q3_answer, q4_answer,
              lead_score, lead_temperature
         FROM friends WHERE id = ?`,
    )
    .bind(friendId)
    .first<JobMatchingLeadState>();
}

/**
 * 会話開始時に呼ぶ。Q1待ちの状態にする。
 *
 * 以前の回答・スコア・温度も合わせてクリアする — アンフォロー後に同じ
 * jobmatch- リンク経由で再フォローした場合など、既に診断済みの友だちで
 * 再度呼ばれることがあるため。状態だけ awaiting_q1 に戻して古いスコア/温度を
 * 残すと、管理画面のリード一覧で「リセットされたのにHOT表示」という
 * 矛盾した行になってしまう。
 */
export async function startJobMatchingConversation(db: D1Database, friendId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE friends
          SET job_matching_conversation_state = 'awaiting_q1',
              q1_answer = NULL, q2_answer = NULL, lead_score = NULL, lead_temperature = NULL,
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(jstNow(), friendId)
    .run();
}

/**
 * Q1の回答を保存し、Q2待ちへ進める。
 *
 * WHERE 句に現在状態 (awaiting_q1) を条件として含む原子的な UPDATE。
 * LINE の postback 再送や連打による同時呼び出しで、両方が「まだ awaiting_q1」
 * と読んでから書き込む競合を防ぐ — 2回目の呼び出しは changes=0 になり、
 * 呼び出し側 (handleJobMatchingPostback) はそれを「既に処理済み」として
 * 後続の LINE push / Discord・Sheets 通知をスキップできる。
 * 戻り値: 実際にこの呼び出しで状態遷移できたら true。
 */
export async function recordQ1Answer(db: D1Database, friendId: string, q1Answer: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE friends SET q1_answer = ?, job_matching_conversation_state = 'awaiting_q2', updated_at = ?
        WHERE id = ? AND job_matching_conversation_state = 'awaiting_q1'`,
    )
    .bind(q1Answer, jstNow(), friendId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Q2の回答とスコアを保存し、診断済みへ進める。
 * recordQ1Answer と同じ理由で awaiting_q2 を条件にした原子的な UPDATE。
 */
export async function recordQ2AnswerAndScore(
  db: D1Database,
  friendId: string,
  q2Answer: string,
  score: number,
  temperature: LeadTemperature,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE friends
          SET q2_answer = ?, lead_score = ?, lead_temperature = ?,
              job_matching_conversation_state = 'diagnosed', updated_at = ?
        WHERE id = ? AND job_matching_conversation_state = 'awaiting_q2'`,
    )
    .bind(q2Answer, score, temperature, jstNow(), friendId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Q3 (稼働できる時間帯) の回答を保存。診断後の追加ヒアリングなので会話
 * ステートは 'diagnosed' のまま変えず、「q3_answer が NULL」を条件にした
 * 原子的 UPDATE で二重回答 (再送・連打) を防ぐ。
 */
export async function recordQ3Answer(db: D1Database, friendId: string, q3Answer: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE friends SET q3_answer = ?, updated_at = ?
        WHERE id = ? AND job_matching_conversation_state = 'diagnosed' AND q3_answer IS NULL`,
    )
    .bind(q3Answer, jstNow(), friendId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Q4 (開始希望時期) の回答を保存。「今すぐ」は本気度の強いシグナルなので
 * スコアを +5 し、閾値 (60/40) をまたいだ場合は温度も引き上げる。
 * Q3 と同様に q4_answer IS NULL 条件の原子的 UPDATE。
 */
export async function recordQ4Answer(db: D1Database, friendId: string, q4Answer: string): Promise<boolean> {
  const boost = q4Answer === 'now' ? 5 : 0;
  const result = await db
    .prepare(
      `UPDATE friends
          SET q4_answer = ?,
              lead_score = CASE WHEN lead_score IS NULL THEN NULL ELSE lead_score + ? END,
              lead_temperature = CASE
                WHEN lead_score IS NULL THEN lead_temperature
                WHEN lead_score + ? >= 60 THEN 'hot'
                WHEN lead_score + ? >= 40 THEN 'warm'
                ELSE 'cold'
              END,
              updated_at = ?
        WHERE id = ? AND job_matching_conversation_state = 'diagnosed'
          AND q3_answer IS NOT NULL AND q4_answer IS NULL`,
    )
    .bind(q4Answer, boost, boost, boost, jstNow(), friendId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
