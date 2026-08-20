import type { LeadTemperature } from './scoring.js';

// リード確定時の Google Sheets CRM 連携 (Phase B)。
// Cloudflare Worker の外側 (Google Apps Script の Web App) が受け口になるため、
// Worker 側はそこへ JSON を POST するだけの薄いヘルパーに留める。GAS 側の
// スクリプトは docs/google-apps-script/job-matching-crm.gs を参照。
//
// Discord 通知 (discord-notify.ts) と同様、汎用送信Webhook基盤には乗せない —
// こちらは GAS 側が期待する専用の JSON 形状があり、汎用基盤の「任意JSONを
// そのままPOST」設計と用途が異なるため、単機能のヘルパーとして切り離す。

export interface SheetsEnv {
  GOOGLE_SHEETS_WEBHOOK_URL?: string;
}

export interface SheetsLeadRow {
  friendId: string;
  friendName: string;
  q1Label: string;
  q2Label: string;
  score: number;
  temperature: LeadTemperature;
  /** JST ISO8601 (jstNow() の出力形式) */
  occurredAt: string;
}

export async function notifySheetsOfLead(env: SheetsEnv, lead: SheetsLeadRow): Promise<void> {
  const webhookUrl = env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) return; // 未設定なら送らない (フェイルセーフ)

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        friendId: lead.friendId,
        friendName: lead.friendName,
        q1Label: lead.q1Label,
        q2Label: lead.q2Label,
        score: lead.score,
        temperature: lead.temperature,
        occurredAt: lead.occurredAt,
      }),
    });
    if (!res.ok) {
      console.error('[job-matching] Sheets notify failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    // Sheets 連携の失敗でリード登録自体を失敗させない。
    console.error('[job-matching] Sheets notify error:', err);
  }
}
