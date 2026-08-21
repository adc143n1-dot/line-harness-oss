import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  runAdvisorAnalysis,
  getLastAdvisorReport,
  detectAutomationCandidates,
} from '../services/advisor.js';

// AIアドバイザー API。分析の実行は明示的なボタン操作 (課金が発生するため)、
// 結果の閲覧・自動化候補の検出は無料。
const advisor = new Hono<Env>();

// キャッシュ済みの最新レポート
advisor.get('/api/advisor/report', async (c) => {
  try {
    const report = await getLastAdvisorReport(c.env.DB);
    return c.json({ success: true, data: report });
  } catch (err) {
    console.error('GET /api/advisor/report error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 分析を今すぐ実行 (Anthropic API を1回呼ぶ)
advisor.post('/api/advisor/analyze', async (c) => {
  try {
    if (!c.env.ANTHROPIC_API_KEY) {
      return c.json(
        { success: false, error: 'ANTHROPIC_API_KEY が未設定です (wrangler secret put ANTHROPIC_API_KEY)' },
        400,
      );
    }
    const report = await runAdvisorAnalysis(c.env.DB, c.env, 'manual');
    return c.json({ success: true, data: report });
  } catch (err) {
    console.error('POST /api/advisor/analyze error:', err);
    return c.json({ success: false, error: 'AI分析に失敗しました。しばらくして再度お試しください。' }, 500);
  }
});

// ルールベースの自動化候補 (AI不要・無料)
advisor.get('/api/advisor/automation-candidates', async (c) => {
  try {
    const candidates = await detectAutomationCandidates(c.env.DB);
    return c.json({ success: true, data: candidates });
  } catch (err) {
    console.error('GET /api/advisor/automation-candidates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { advisor };
