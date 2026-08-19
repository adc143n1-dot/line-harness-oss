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
  lead_score: number | null;
  lead_temperature: LeadTemperature | null;
}

export async function getJobMatchingLeadState(
  db: D1Database,
  friendId: string,
): Promise<JobMatchingLeadState | null> {
  return db
    .prepare(
      `SELECT job_matching_conversation_state, q1_answer, q2_answer, lead_score, lead_temperature
         FROM friends WHERE id = ?`,
    )
    .bind(friendId)
    .first<JobMatchingLeadState>();
}

/** 会話開始時に呼ぶ。Q1待ちの状態にする。 */
export async function startJobMatchingConversation(db: D1Database, friendId: string): Promise<void> {
  await db
    .prepare(`UPDATE friends SET job_matching_conversation_state = 'awaiting_q1', updated_at = ? WHERE id = ?`)
    .bind(jstNow(), friendId)
    .run();
}

/** Q1の回答を保存し、Q2待ちへ進める。 */
export async function recordQ1Answer(db: D1Database, friendId: string, q1Answer: string): Promise<void> {
  await db
    .prepare(
      `UPDATE friends SET q1_answer = ?, job_matching_conversation_state = 'awaiting_q2', updated_at = ? WHERE id = ?`,
    )
    .bind(q1Answer, jstNow(), friendId)
    .run();
}

/** Q2の回答とスコアを保存し、診断済みへ進める。 */
export async function recordQ2AnswerAndScore(
  db: D1Database,
  friendId: string,
  q2Answer: string,
  score: number,
  temperature: LeadTemperature,
): Promise<void> {
  await db
    .prepare(
      `UPDATE friends
          SET q2_answer = ?, lead_score = ?, lead_temperature = ?,
              job_matching_conversation_state = 'diagnosed', updated_at = ?
        WHERE id = ?`,
    )
    .bind(q2Answer, score, temperature, jstNow(), friendId)
    .run();
}
