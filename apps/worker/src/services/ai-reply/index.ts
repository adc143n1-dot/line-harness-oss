import type { LineClient } from '@line-crm/line-sdk';
import type { Friend } from '@line-crm/db';
import { logOutgoingMessage } from '../event-bus.js';
import type { AiReplyMessage, AiReplyProvider } from './provider.js';
import { AnthropicProvider } from './anthropic-provider.js';

export type { AiReplyProvider, AiReplyRequest, AiReplyMessage } from './provider.js';
export { AnthropicProvider } from './anthropic-provider.js';

export interface AiReplyEnv {
  /** 'true' のときだけ動作する。フェイルセーフ (未設定なら無効)。 */
  AI_REPLY_ENABLED?: string;
  /** 現状は 'anthropic' のみ。差し替え先を増やす場合はここに分岐を足す。 */
  AI_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  AI_REPLY_MODEL?: string;
  AI_REPLY_SYSTEM_PROMPT?: string;
}

const DEFAULT_SYSTEM_PROMPT =
  'あなたは LINE 公式アカウントの一次対応を担当するアシスタントです。' +
  '簡潔・丁寧な日本語で 2〜3 文程度に収めて回答してください。' +
  '料金の最終確定や個別事情の判断など断定できない相談には、' +
  '「担当スタッフが追ってご案内します」と伝えてください。';

const HISTORY_LIMIT = 10;

function buildProvider(env: AiReplyEnv): AiReplyProvider | null {
  const providerName = env.AI_PROVIDER ?? 'anthropic';
  if (providerName === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) return null;
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_REPLY_MODEL);
  }
  // 他プロバイダを追加する場合はここに分岐を足す。呼び出し側は
  // AiReplyProvider インターフェースだけを見るので変更不要。
  return null;
}

export interface MaybeSendAiReplyResult {
  sent: boolean;
  reason?:
    | 'disabled'
    | 'operator_assigned'
    | 'account_disabled'
    | 'daily_limit_reached'
    | 'provider_not_configured'
    | 'generation_failed'
    | 'push_failed';
}

/**
 * アカウント別のオプトアウト設定 (account_settings.ai_reply_enabled) を見る。
 * 未設定 (null) はマスタースイッチ (env.AI_REPLY_ENABLED) の判断に従う ——
 * マスターを ON にしただけで全アカウント有効になる既存挙動を変えないため。
 */
async function isAccountOptedOut(db: D1Database, lineAccountId: string | null): Promise<boolean> {
  if (!lineAccountId) return false;
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'ai_reply_enabled'`)
    .bind(lineAccountId)
    .first<{ value: string }>();
  return row?.value === 'false';
}

/**
 * 日次上限を messages_log の実測でチェックする。専用のカウンターテーブルは
 * 持たない (二重管理・書き込み競合を避けるため)。境界付近での多少の超過は
 * 許容する — 会計上の厳密なガードではなく運用コストの抑制が目的。
 */
async function isDailyLimitReached(
  db: D1Database,
  lineAccountId: string | null,
  todayPrefix: string,
): Promise<boolean> {
  if (!lineAccountId) return false;
  const limitRow = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'ai_reply_daily_limit'`)
    .bind(lineAccountId)
    .first<{ value: string }>();
  if (!limitRow) return false;
  const limit = Number(limitRow.value);
  if (!Number.isFinite(limit)) return false;

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages_log WHERE source = 'ai_reply' AND line_account_id = ? AND created_at LIKE ?`,
    )
    .bind(lineAccountId, `${todayPrefix}%`)
    .first<{ n: number }>();
  return (countRow?.n ?? 0) >= limit;
}

/**
 * キーワード自動応答 (auto_replies) に一致しなかった受信テキストへの AI 一次応答。
 *
 * - 担当スタッフが付いているチャットには送らない。有人対応中に AI が割り込むと、
 *   スタッフの返信と重複・矛盾する会話になり得るため。
 * - 生成・送信いずれかが失敗しても例外を投げない。AI 応答はあくまで補助であり、
 *   ここで失敗して webhook 処理自体を止めてはいけない。
 * - 応答は pushMessage (有料枠) を使う。LLM 生成には数百ms〜数秒かかることがあり、
 *   replyToken の約1分の有効期限を使い切るには timing が不安定なため。
 * - chats テーブルは更新しない (last_replied_by 等は 'operator'/'user' の二値で
 *   AI を表現できないため)。人間の初回返信が SLA 計測の基準であり続ける。
 */
export async function maybeSendAiReply(
  db: D1Database,
  lineClient: LineClient,
  friend: Friend,
  chat: { operator_id: string | null },
  incomingText: string,
  env: AiReplyEnv,
  opts: { lineAccountId?: string | null } = {},
): Promise<MaybeSendAiReplyResult> {
  if (env.AI_REPLY_ENABLED !== 'true') return { sent: false, reason: 'disabled' };
  if (chat.operator_id) return { sent: false, reason: 'operator_assigned' };

  const lineAccountId = opts.lineAccountId ?? null;
  if (await isAccountOptedOut(db, lineAccountId)) return { sent: false, reason: 'account_disabled' };

  const todayPrefix = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  if (await isDailyLimitReached(db, lineAccountId, todayPrefix)) {
    return { sent: false, reason: 'daily_limit_reached' };
  }

  const provider = buildProvider(env);
  if (!provider) return { sent: false, reason: 'provider_not_configured' };

  const historyRows = await db
    .prepare(
      `SELECT direction, message_type, content FROM messages_log
        WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')
        ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(friend.id, HISTORY_LIMIT)
    .all<{ direction: string; message_type: string; content: string }>();

  const history: AiReplyMessage[] = historyRows.results
    .slice()
    .reverse()
    .filter((row) => row.message_type === 'text')
    .map((row) => ({
      role: row.direction === 'incoming' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    }));
  history.push({ role: 'user', content: incomingText });

  let replyText: string;
  try {
    replyText = await provider.generateReply({
      systemPrompt: env.AI_REPLY_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
      history,
    });
  } catch (err) {
    console.error('[ai-reply] generation failed:', err);
    return { sent: false, reason: 'generation_failed' };
  }

  try {
    await lineClient.pushTextMessage(friend.line_user_id, replyText);
  } catch (err) {
    console.error('[ai-reply] push failed:', err);
    return { sent: false, reason: 'push_failed' };
  }

  await logOutgoingMessage(db, {
    friendId: friend.id,
    messageType: 'text',
    content: replyText,
    deliveryType: 'push',
    source: 'ai_reply',
    lineAccountId: opts.lineAccountId ?? null,
  });

  return { sent: true };
}
