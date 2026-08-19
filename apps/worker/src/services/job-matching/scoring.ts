// リードスコアリング — Q1(働き方)・Q2(ジャンル)の回答から0〜70点の
// 「本気度スコア」を算出する。LLMは使わない決定的な計算 (固定の点数表)。
//
// 60〜70=HOT(即日対応推奨) / 40〜59=WARM(24h以内対応) / 10〜39=COLD(自動フォロー)。
// 最小構成 (Q1=まずは相談だけ + Q2=その他) でも 20点になるため、
// 実際に到達し得る点数はすべていずれかの温度区分に収まる。

export type Q1Answer = 'fulltime' | 'weekly' | 'gap_time' | 'consult_only';
export type Q2Answer = 'high_value' | 'sns_management' | 'registered_gig' | 'single_gig' | 'other';
export type LeadTemperature = 'hot' | 'warm' | 'cold';

export const Q1_LABELS: Record<Q1Answer, string> = {
  fulltime: '本業レベルでしっかり稼ぎたい',
  weekly: '週に1,2回',
  gap_time: 'すきま時間だけ',
  consult_only: 'まずは相談だけ',
};

export const Q2_LABELS: Record<Q2Answer, string> = {
  high_value: '高額案件',
  sns_management: 'SNS運用',
  registered_gig: '登録案件',
  single_gig: '単発案件',
  other: 'その他',
};

const Q1_SCORES: Record<Q1Answer, number> = {
  fulltime: 40,
  weekly: 30,
  gap_time: 20,
  consult_only: 10,
};

const Q2_SCORES: Record<Q2Answer, number> = {
  high_value: 30,
  sns_management: 25,
  registered_gig: 20,
  single_gig: 15,
  other: 10,
};

export interface LeadScoreResult {
  score: number;
  temperature: LeadTemperature;
}

export function scoreLead(q1: Q1Answer, q2: Q2Answer): LeadScoreResult {
  const score = Q1_SCORES[q1] + Q2_SCORES[q2];
  const temperature: LeadTemperature = score >= 60 ? 'hot' : score >= 40 ? 'warm' : 'cold';
  return { score, temperature };
}
