import type { LeadTemperature } from './scoring.js';

// リード確定時のDiscord通知。汎用の送信Webhook基盤 (fireOutgoingWebhooks /
// event-bus.ts) には乗せない — Discordの着信Webhookは {content: "..."} という
// 専用形式が必須で、汎用基盤の「任意のJSONペイロードをそのままPOSTする」設計
// と噛み合わない。既存の仕組みを拡張して両対応させると、Slack等の既存の
// 送信Webhook利用先に予期せぬ影響が出るリスクがあるため、単機能のヘルパーとして
// 完全に切り離す。

export interface JobMatchingEnv {
  DISCORD_LEADS_WEBHOOK_URL?: string;
}

export interface LeadNotification {
  friendName: string;
  q1Label: string;
  q2Label: string;
  score: number;
  temperature: LeadTemperature;
}

const TEMPERATURE_LABEL: Record<LeadTemperature, string> = {
  hot: '🔥 HOT (即日対応推奨)',
  warm: '🌤️ WARM (24h以内対応)',
  cold: '❄️ COLD (自動フォロー)',
};

export async function notifyDiscordOfLead(env: JobMatchingEnv, lead: LeadNotification): Promise<void> {
  const webhookUrl = env.DISCORD_LEADS_WEBHOOK_URL;
  if (!webhookUrl) return; // 未設定なら送らない (フェイルセーフ)

  const content =
    `【新規リード登録】\n` +
    `名前: ${lead.friendName}\n` +
    `Q1: ${lead.q1Label} / Q2: ${lead.q2Label}\n` +
    `本気度スコア: ${lead.score}点 ${TEMPERATURE_LABEL[lead.temperature]}`;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error('[job-matching] Discord notify failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    // Discord通知の失敗でリード登録自体を失敗させない。
    console.error('[job-matching] Discord notify error:', err);
  }
}
