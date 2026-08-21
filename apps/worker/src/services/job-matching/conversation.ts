import type { LineClient } from '@line-crm/line-sdk';
import { quickReply, withQuickReply } from '@line-crm/line-sdk';
import type { Friend } from '@line-crm/db';
import {
  getJobMatchingLeadState,
  startJobMatchingConversation,
  recordQ1Answer,
  recordQ2AnswerAndScore,
  recordQ3Answer,
  recordQ4Answer,
  jstNow,
} from '@line-crm/db';
import { logOutgoingMessage } from '../event-bus.js';
import { scoreLead, Q1_LABELS, Q2_LABELS, Q3_LABELS, Q4_LABELS } from './scoring.js';
import type { Q1Answer, Q2Answer, Q3Answer, Q4Answer } from './scoring.js';
import { notifyDiscordOfLead } from './discord-notify.js';
import type { JobMatchingEnv } from './discord-notify.js';
import { notifySheetsOfLead } from './sheets-notify.js';
import type { SheetsEnv } from './sheets-notify.js';
import type { AiReplyProvider } from '../ai-reply/index.js';

// 副業マッチング会話ステートマシン (Phase A)。
//
// 起点は webhook.ts の follow イベントで、friendRefCode が JOB_MATCHING_REF_PREFIX
// で始まる場合のみ開始する (entry_routes.tag_id はこのリポジトリで実際には
// friends へ適用されておらず未接続だったため、既存の tag 自動付与には頼らず、
// ref_code のプレフィックス規約という自己完結した条件にした)。
export const JOB_MATCHING_REF_PREFIX = 'jobmatch-';

const Q1_POSTBACK_PREFIX = 'jobmatch_q1:';
const Q2_POSTBACK_PREFIX = 'jobmatch_q2:';
const Q3_POSTBACK_PREFIX = 'jobmatch_q3:';
const Q4_POSTBACK_PREFIX = 'jobmatch_q4:';

// 診断結果メッセージの生成に使うプロンプト。PDFの仕様 (詐欺的勧誘表現・
// 断定的収入表現・個人情報以外への誘導の禁止) をそのまま踏襲する。
// 期限煽り・不安喚起の指示は入れない (合意済みの制約)。
const DIAGNOSIS_SYSTEM_PROMPT =
  'あなたは副業マッチングサービスの丁寧なAIオペレーターです。' +
  'ユーザーの回答から最適な副業カテゴリを診断し、親しみやすく簡潔なLINEメッセージ (3〜4文) を作成してください。' +
  '禁止事項: 詐欺的な勧誘表現、根拠のない「かんたん」「高額」の断定、収入保証や「絶対」「必ず」などの断定表現、' +
  '期限を煽る表現（「本日限り」「枠が埋まり次第」等）、個人情報の入力以外への誘導。';

function q1QuickReply() {
  return quickReply(
    (Object.entries(Q1_LABELS) as [Q1Answer, string][]).map(([key, label]) => ({
      type: 'action' as const,
      action: { type: 'postback' as const, label, data: `${Q1_POSTBACK_PREFIX}${key}`, displayText: label },
    })),
  );
}

function q2QuickReply() {
  return quickReply(
    (Object.entries(Q2_LABELS) as [Q2Answer, string][]).map(([key, label]) => ({
      type: 'action' as const,
      action: { type: 'postback' as const, label, data: `${Q2_POSTBACK_PREFIX}${key}`, displayText: label },
    })),
  );
}

function q3QuickReply() {
  return quickReply(
    (Object.entries(Q3_LABELS) as [Q3Answer, string][]).map(([key, label]) => ({
      type: 'action' as const,
      action: { type: 'postback' as const, label, data: `${Q3_POSTBACK_PREFIX}${key}`, displayText: label },
    })),
  );
}

function q4QuickReply() {
  return quickReply(
    (Object.entries(Q4_LABELS) as [Q4Answer, string][]).map(([key, label]) => ({
      type: 'action' as const,
      action: { type: 'postback' as const, label, data: `${Q4_POSTBACK_PREFIX}${key}`, displayText: label },
    })),
  );
}

/** friendRefCode が副業マッチング流入かどうか判定する。 */
export function isJobMatchingReferral(friendRefCode: string | null | undefined): boolean {
  return !!friendRefCode && friendRefCode.startsWith(JOB_MATCHING_REF_PREFIX);
}

/**
 * 友だち追加時に呼ぶ。ウェルカムメッセージ + Q1 のクイックリプライを送信し、
 * 会話状態を awaiting_q1 にする。
 */
export async function beginJobMatchingConversation(
  db: D1Database,
  lineClient: LineClient,
  friend: Friend,
): Promise<void> {
  await startJobMatchingConversation(db, friend.id);

  const welcome = withQuickReply(
    { type: 'text' as const, text: 'こんにちは！友だち追加ありがとうございます😊\nあなたに合ったお仕事をご紹介するために、まずは2つの質問にお答えください。\n\nQ1. 現在のお仕事やライフスタイルは？' },
    q1QuickReply(),
  );
  await lineClient.pushMessage(friend.line_user_id, [welcome]);
  await logOutgoingMessage(db, {
    friendId: friend.id,
    messageType: 'text',
    content: welcome.text,
    deliveryType: 'push',
    source: 'job_matching',
  });
}

export interface HandlePostbackResult {
  handled: boolean;
}

/**
 * postback イベントを受けたときに呼ぶ。job-matching の Q1/Q2 postback data で
 * なければ handled:false を返し、呼び出し側 (webhook.ts) は通常の
 * auto_replies マッチングにフォールバックする。
 */
export async function handleJobMatchingPostback(
  db: D1Database,
  lineClient: LineClient,
  friend: Friend,
  postbackData: string,
  aiProvider: AiReplyProvider | null,
  env: JobMatchingEnv & SheetsEnv,
): Promise<HandlePostbackResult> {
  if (postbackData.startsWith(Q1_POSTBACK_PREFIX)) {
    const state = await getJobMatchingLeadState(db, friend.id);
    if (state?.job_matching_conversation_state !== 'awaiting_q1') return { handled: false };

    const q1 = postbackData.slice(Q1_POSTBACK_PREFIX.length) as Q1Answer;
    if (!(q1 in Q1_LABELS)) return { handled: false };
    // 原子的な状態遷移。LINEの再送や連打で同時に呼ばれても、状態を実際に
    // awaiting_q1→awaiting_q2 に進められたのは1回だけになる。2回目以降は
    // false が返るので、Q2案内の再送・二重ログを避けて早期return する
    // (postback自体はjob-matching向けなので handled:true のまま)。
    const claimed = await recordQ1Answer(db, friend.id, q1);
    if (!claimed) return { handled: true };

    const q2Msg = withQuickReply(
      { type: 'text' as const, text: 'ありがとうございます！\nQ2. どんなジャンルのお仕事にご興味がありますか？' },
      q2QuickReply(),
    );
    await lineClient.pushMessage(friend.line_user_id, [q2Msg]);
    await logOutgoingMessage(db, {
      friendId: friend.id, messageType: 'text', content: q2Msg.text, deliveryType: 'push', source: 'job_matching',
    });
    return { handled: true };
  }

  if (postbackData.startsWith(Q2_POSTBACK_PREFIX)) {
    const state = await getJobMatchingLeadState(db, friend.id);
    if (state?.job_matching_conversation_state !== 'awaiting_q2' || !state.q1_answer) return { handled: false };

    const q2 = postbackData.slice(Q2_POSTBACK_PREFIX.length) as Q2Answer;
    if (!(q2 in Q2_LABELS)) return { handled: false };

    const q1 = state.q1_answer as Q1Answer;
    const { score, temperature } = scoreLead(q1, q2);
    // recordQ1Answer と同じ原子的claim。false なら既に別の呼び出しが処理済み
    // なので、AI診断の再生成・LINE再送・Discord/Sheetsへの二重通知を避ける。
    const claimed = await recordQ2AnswerAndScore(db, friend.id, q2, score, temperature);
    if (!claimed) return { handled: true };

    const diagnosisText = await generateDiagnosisMessage(aiProvider, friend, q1, q2);
    const diagnosisMsg = { type: 'text' as const, text: diagnosisText };
    await lineClient.pushMessage(friend.line_user_id, [diagnosisMsg]);
    await logOutgoingMessage(db, {
      friendId: friend.id, messageType: 'text', content: diagnosisText, deliveryType: 'push', source: 'job_matching',
    });

    await notifyDiscordOfLead(env, {
      friendName: friend.display_name || '名前なし',
      q1Label: Q1_LABELS[q1],
      q2Label: Q2_LABELS[q2],
      score,
      temperature,
    });

    await notifySheetsOfLead(env, {
      friendId: friend.id,
      friendName: friend.display_name || '名前なし',
      q1Label: Q1_LABELS[q1],
      q2Label: Q2_LABELS[q2],
      score,
      temperature,
      occurredAt: jstNow(),
    });

    // 追加ヒアリング (Q3: 稼働時間帯)。マッチング精度向上のための任意質問で、
    // 答えなくても診断・通知は完了済み (ここで離脱しても実害はない)
    const q3Msg = withQuickReply(
      { type: 'text' as const, text: 'よろしければ、ご案内の精度を上げるためにあと2つだけ教えてください。\n\nQ3. お仕事に使える時間帯はいつですか？' },
      q3QuickReply(),
    );
    await lineClient.pushMessage(friend.line_user_id, [q3Msg]);
    await logOutgoingMessage(db, {
      friendId: friend.id, messageType: 'text', content: q3Msg.text, deliveryType: 'push', source: 'job_matching',
    });

    return { handled: true };
  }

  // Q3 (稼働時間帯)。診断後の追加質問なので state は 'diagnosed' のまま、
  // q3_answer IS NULL を条件にした原子的 UPDATE (recordQ3Answer) で二重処理を防ぐ
  if (postbackData.startsWith(Q3_POSTBACK_PREFIX)) {
    const q3 = postbackData.slice(Q3_POSTBACK_PREFIX.length) as Q3Answer;
    if (!(q3 in Q3_LABELS)) return { handled: false };

    const claimed = await recordQ3Answer(db, friend.id, q3);
    if (!claimed) return { handled: true }; // 未診断/回答済み/再送 — 何もしない

    const q4Msg = withQuickReply(
      { type: 'text' as const, text: 'ありがとうございます！\nQ4. いつ頃から始めたいですか？' },
      q4QuickReply(),
    );
    await lineClient.pushMessage(friend.line_user_id, [q4Msg]);
    await logOutgoingMessage(db, {
      friendId: friend.id, messageType: 'text', content: q4Msg.text, deliveryType: 'push', source: 'job_matching',
    });
    return { handled: true };
  }

  // Q4 (開始希望時期)。「今すぐ」はスコア+5と温度引き上げ (recordQ4Answer 内)
  if (postbackData.startsWith(Q4_POSTBACK_PREFIX)) {
    const q4 = postbackData.slice(Q4_POSTBACK_PREFIX.length) as Q4Answer;
    if (!(q4 in Q4_LABELS)) return { handled: false };

    const claimed = await recordQ4Answer(db, friend.id, q4);
    if (!claimed) return { handled: true };

    const thanksText =
      'ご回答ありがとうございました！✨\nいただいた内容をもとに、あなたに合ったお仕事を担当よりご案内します。ご質問があればいつでもメッセージしてください。';
    await lineClient.pushMessage(friend.line_user_id, [{ type: 'text' as const, text: thanksText }]);
    await logOutgoingMessage(db, {
      friendId: friend.id, messageType: 'text', content: thanksText, deliveryType: 'push', source: 'job_matching',
    });
    return { handled: true };
  }

  return { handled: false };
}

async function generateDiagnosisMessage(
  aiProvider: AiReplyProvider | null,
  friend: Friend,
  q1: Q1Answer,
  q2: Q2Answer,
): Promise<string> {
  const fallback =
    `${friend.display_name || ''}さん、診断結果が出ました！✅\n` +
    `「${Q1_LABELS[q1]}」「${Q2_LABELS[q2]}」のご希望ですね。\n` +
    `あなたに合うお仕事をご紹介できます。次のステップとして、担当よりご案内します。`;

  if (!aiProvider) return fallback;

  try {
    return await aiProvider.generateReply({
      systemPrompt: DIAGNOSIS_SYSTEM_PROMPT,
      history: [
        { role: 'user', content: `Q1(働き方): ${Q1_LABELS[q1]}\nQ2(ジャンル): ${Q2_LABELS[q2]}\n診断結果メッセージを作成してください。` },
      ],
      maxTokens: 300,
    });
  } catch (err) {
    console.error('[job-matching] diagnosis generation failed, using fallback:', err);
    return fallback;
  }
}
