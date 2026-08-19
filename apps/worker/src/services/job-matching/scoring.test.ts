import { describe, expect, test } from 'vitest';
import { scoreLead, Q1_LABELS, Q2_LABELS } from './scoring.js';
import type { Q1Answer, Q2Answer } from './scoring.js';

describe('scoreLead', () => {
  test('最高点の組み合わせは70点・HOT', () => {
    expect(scoreLead('fulltime', 'high_value')).toEqual({ score: 70, temperature: 'hot' });
  });

  test('最低点の組み合わせは20点・COLD', () => {
    expect(scoreLead('consult_only', 'other')).toEqual({ score: 20, temperature: 'cold' });
  });

  test('60点ちょうどはHOT、59点はWARM (境界値)', () => {
    // weekly(30) + high_value(30) = 60
    expect(scoreLead('weekly', 'high_value')).toEqual({ score: 60, temperature: 'hot' });
    // gap_time(20) + high_value(30) = 50 (WARM)。59点ちょうどの組み合わせは
    // 点数表に存在しないため、境界の40点側で確認する
    expect(scoreLead('gap_time', 'high_value')).toEqual({ score: 50, temperature: 'warm' });
  });

  test('40点ちょうどはWARM、39点はCOLD (境界値)', () => {
    // gap_time(20) + registered_gig(20) = 40
    expect(scoreLead('gap_time', 'registered_gig')).toEqual({ score: 40, temperature: 'warm' });
    // consult_only(10) + registered_gig(20) = 30 (COLD)
    expect(scoreLead('consult_only', 'registered_gig')).toEqual({ score: 30, temperature: 'cold' });
  });

  test('全組み合わせが必ずいずれかの温度区分に収まる (20〜70点の範囲チェック)', () => {
    const q1s = Object.keys(Q1_LABELS) as Q1Answer[];
    const q2s = Object.keys(Q2_LABELS) as Q2Answer[];
    for (const q1 of q1s) {
      for (const q2 of q2s) {
        const { score, temperature } = scoreLead(q1, q2);
        expect(score).toBeGreaterThanOrEqual(20);
        expect(score).toBeLessThanOrEqual(70);
        expect(['hot', 'warm', 'cold']).toContain(temperature);
      }
    }
  });
});
