import type { LineClient } from '@line-crm/line-sdk';
import { quickReply, withQuickReply } from '@line-crm/line-sdk';
import type { Friend } from '@line-crm/db';
import {
  getJobMatchingLeadState,
  startJobMatchingConversation,
  recordQ1Answer,
  recordQ2AnswerAndScore,
} from '@line-crm/db';
import { logOutgoingMessage } from '../event-bus.js';
import { scoreLead, Q1_LABELS, Q2_LABELS } from './scoring.js';
import type { Q1Answer, Q2Answer } from './scoring.js';
import { notifyDiscordOfLead } from './discord-notify.js';
import type { JobMatchingEnv } from './discord-notify.js';
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
  env: JobMatchingEnv,
): Promise<HandlePostbackResult> {
  if (postbackData.startsWith(Q1_POSTBACK_PREFIX)) {
    const state = await getJobMatchingLeadState(db, friend.id);
    if (state?.job_matching_conversation_state !== 'awaiting_q1') return { handled: false };

    const q1 = postbackData.slice(Q1_POSTBACK_PREFIX.length) as Q1Answer;
    if (!(q1 in Q1_LABELS)) return { handled: false };
    await recordQ1Answer(db, friend.id, q1);

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
    await recordQ2AnswerAndScore(db, friend.id, q2, score, temperature);

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
