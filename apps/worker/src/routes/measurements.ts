import { Hono } from 'hono';
import type { Env } from '../index.js';

const measurements = new Hono<Env>();

// GET /api/measurements — proxy aggregated stats from line-dashboard
measurements.get('/api/measurements', async (c) => {
  try {
    const url = c.env.DASHBOARD_STATS_URL || 'https://line-dashboard.t08077196051.workers.dev/api/stats';
    const user = c.env.DASHBOARD_STATS_USER;
    const pass = c.env.DASHBOARD_STATS_PASS;
    if (!user || !pass) {
      return c.json({ success: false, error: 'DASHBOARD_STATS_USER/DASHBOARD_STATS_PASS not configured' }, 500);
    }
    const auth = btoa(`${user}:${pass}`);
    const res = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
    if (!res.ok) {
      return c.json({ success: false, error: `upstream error ${res.status}` }, 502);
    }
    const data = await res.json();
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/measurements error:', err);
    return c.json({ success: false, error: 'failed to fetch measurements' }, 500);
  }
});

export { measurements };
