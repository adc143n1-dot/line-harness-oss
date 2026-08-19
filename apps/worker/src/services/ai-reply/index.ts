import type { LineClient } from '@line-crm/line-sdk';
import type { Friend } from '@line-crm/db';
import { getAccountSetting, setAccountSetting } from '@line-crm/db';
import { logOutgoingMessage, fireEvent } from '../event-bus.js';
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

export function buildProvider(env: AiReplyEnv): AiReplyProvider | null {
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

interface DailyLimitCheck {
  reached: boolean;
  limit: number;
  count: number;
}

/**
 * 日次上限を messages_log の実測でチェックする。専用のカウンターテーブルは
 * 持たない (二重管理・書き込み競合を避けるため)。境界付近での多少の超過は
 * 許容する — 会計上の厳密なガードではなく運用コストの抑制が目的。
 */
async function checkDailyLimit(
  db: D1Database,
  lineAccountId: string | null,
  todayPrefix: string,
): Promise<DailyLimitCheck | null> {
  if (!lineAccountId) return null;
  const limitRow = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'ai_reply_daily_limit'`)
    .bind(lineAccountId)
    .first<{ value: string }>();
  if (!limitRow) return null;
  const limit = Number(limitRow.value);
  if (!Number.isFinite(limit)) return null;

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages_log WHERE source = 'ai_reply' AND line_account_id = ? AND created_at LIKE ?`,
    )
    .bind(lineAccountId, `${todayPrefix}%`)
    .first<{ n: number }>();
  const count = countRow?.n ?? 0;
  return { reached: count >= limit, limit, count };
}

const LIMIT_ALERT_DATE_KEY = 'ai_reply_limit_alert_sent_date';

/**
 * 日次上限到達を、運営者が /webhooks で設定済みの送信Webhook (Slack等) へ
 * 通知する。上限自体は前回のセッションで実装済みだが、到達しても誰も気づけ
 * ないまま無応答が続く状態だったため、これを埋める。
 *
 * 通知チャネルは新規に作らない。fireEvent() は既存の送信Webhook配信基盤
 * (event-bus.ts) をそのまま使う — event_types に 'ai_reply_daily_limit_reached'
 * (または '*') を登録した送信Webhookへ自動的に届く。
 *
 * 同日中に何度も届いても意味が無い (最初の1件で運営者は気づける) ので、
 * account_settings に当日の送信済みフラグを立てて同日の再送を防ぐ。
 */
async function alertDailyLimitReachedOnce(
  db: D1Database,
  lineAccountId: string,
  check: DailyLimitCheck,
  todayPrefix: string,
): Promise<void> {
  const alreadySent = await getAccountSetting(db, lineAccountId, LIMIT_ALERT_DATE_KEY);
  if (alreadySent === todayPrefix) return;

  await setAccountSetting(db, lineAccountId, LIMIT_ALERT_DATE_KEY, todayPrefix);
  await fireEvent(db, 'ai_reply_daily_limit_reached', {
    eventData: { lineAccountId, limit: check.limit, count: check.count, date: todayPrefix },
  });
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
  const limitCheck = await checkDailyLimit(db, lineAccountId, todayPrefix);
  if (limitCheck?.reached) {
    // lineAccountId は checkDailyLimit が null を返さなかった時点で必ず string
    // (checkDailyLimit は lineAccountId が null なら常に null を返す)。
    await alertDailyLimitReachedOnce(db, lineAccountId as string, limitCheck, todayPrefix);
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
