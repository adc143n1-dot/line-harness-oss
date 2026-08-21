import { Hono } from 'hono';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

const jobMatchingLeads = new Hono<Env>();

interface JobMatchingLeadRow {
  id: string;
  display_name: string | null;
  picture_url: string | null;
  q1_answer: string | null;
  q2_answer: string | null;
  q3_answer: string | null;
  q4_answer: string | null;
  lead_score: number | null;
  lead_temperature: 'hot' | 'warm' | 'cold' | null;
  job_matching_conversation_state: 'awaiting_q1' | 'awaiting_q2' | 'diagnosed' | null;
  operator_id: string | null;
  chat_status: string | null;
  created_at: string;
  updated_at: string;
}

function serializeLead(row: JobMatchingLeadRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    q1Answer: row.q1_answer,
    q2Answer: row.q2_answer,
    q3Answer: row.q3_answer,
    q4Answer: row.q4_answer,
    leadScore: row.lead_score,
    leadTemperature: row.lead_temperature,
    conversationState: row.job_matching_conversation_state,
    // 担当スタッフと対応状況 (HOTリードに誰も付いていないことを一覧で見せる)
    operatorId: row.operator_id,
    chatStatus: row.chat_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/job-matching/leads - 副業マッチング診断を開始した友だちの一覧。
// job_matching_conversation_state が NULL (未開始) の友だちは対象外。
jobMatchingLeads.get(
  '/api/job-matching/leads',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    try {
      const limit = Number(c.req.query('limit') ?? '50');
      const offset = Number(c.req.query('offset') ?? '0');
      const temperature = c.req.query('temperature');
      const search = c.req.query('search');
      const db = c.env.DB;

      const conditions = ['f.job_matching_conversation_state IS NOT NULL'];
      const binds: unknown[] = [];
      if (temperature === 'hot' || temperature === 'warm' || temperature === 'cold') {
        conditions.push('f.lead_temperature = ?');
        binds.push(temperature);
      }
      if (search) {
        conditions.push('f.display_name LIKE ?');
        binds.push(`%${search}%`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;

      const countStmt = db.prepare(`SELECT COUNT(*) as count FROM friends f ${where}`);
      const total = (await countStmt.bind(...binds).first<{ count: number }>())?.count ?? 0;

      const listStmt = db.prepare(
        `WITH latest_chat AS (
           SELECT friend_id, operator_id, status, MAX(created_at) AS created_at
           FROM chats GROUP BY friend_id
         )
         SELECT f.id, f.display_name, f.picture_url, f.q1_answer, f.q2_answer,
                f.q3_answer, f.q4_answer,
                f.lead_score, f.lead_temperature, f.job_matching_conversation_state,
                lc.operator_id, lc.status AS chat_status,
                f.created_at, f.updated_at
         FROM friends f
         LEFT JOIN latest_chat lc ON lc.friend_id = f.id
         ${where}
         ORDER BY f.lead_score DESC, f.updated_at DESC
         LIMIT ? OFFSET ?`,
      );
      const items = (await listStmt.bind(...binds, limit, offset).all<JobMatchingLeadRow>()).results;

      return c.json({
        success: true,
        data: {
          items: items.map(serializeLead),
          total,
          page: Math.floor(offset / limit) + 1,
          limit,
          hasNextPage: offset + limit < total,
        },
      });
    } catch (err) {
      console.error('GET /api/job-matching/leads error:', err);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  },
);

export { jobMatchingLeads };
