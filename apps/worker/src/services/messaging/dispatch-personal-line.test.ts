import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../index.js';

const dbMocks = vi.hoisted(() => ({
  jstNow: vi.fn(() => '2026-08-28T10:00:00.000+09:00'),
  getLineAccountById: vi.fn(),
  getTelegramAccountById: vi.fn(),
  getPersonalLineAccountById: vi.fn(),
}));
vi.mock('@line-crm/db', () => dbMocks);

import { deliverToFriend } from './dispatch.js';

const ACCOUNT = {
  id: 'acc1',
  name: 'n',
  bridge_base_url: 'https://bridge.example/',
  bridge_secret: 'BSEK',
  inbound_secret: 'ISEK',
  is_active: 1,
  display_order: 0,
  created_at: '',
  updated_at: '',
};

const FRIEND = {
  id: 'friend-pl-1',
  line_user_id: 'pl:acc1:Umid123',
  channel: 'personal_line',
  personal_line_user_id: 'Umid123',
  personal_line_account_id: 'acc1',
} as unknown as Parameters<typeof deliverToFriend>[1];

function fakeDb() {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const st = {
        params: [] as unknown[],
        bind(...p: unknown[]) { st.params = p; return st; },
        async run() { inserts.push({ sql, params: st.params }); return { success: true }; },
      };
      return st;
    },
  };
  return { db: db as unknown as D1Database, inserts };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getPersonalLineAccountById.mockResolvedValue(ACCOUNT);
});

describe('deliverToFriend → personal_line', () => {
  it('POSTs text to bridge {base}/send with Bearer and logs outgoing', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, inserts } = fakeDb();
    const res = await deliverToFriend(
      { DB: db } as unknown as Env['Bindings'],
      FRIEND,
      { type: 'text', content: 'やあ' },
      { source: 'manual' },
    );
    expect(res.ok).toBe(true);
    // 送信先URL・ヘッダ・ボディ
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://bridge.example/send');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer BSEK');
    expect(JSON.parse(init.body as string)).toEqual({ to: 'Umid123', type: 'text', content: 'やあ' });
    // 成功時に messages_log へ outgoing 記録
    const log = inserts.find((q) => q.sql.includes('INSERT INTO messages_log'));
    expect(log).toBeDefined();
    expect(log!.params).toContain('personal_line');
  });

  it('rejects flex and does not log', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { db, inserts } = fakeDb();
    const res = await deliverToFriend(
      { DB: db } as unknown as Env['Bindings'],
      FRIEND,
      { type: 'flex', content: '{}' },
      { source: 'manual' },
    );
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts.find((q) => q.sql.includes('INSERT INTO messages_log'))).toBeUndefined();
  });

  it('fails when bridge_base_url is not set', async () => {
    dbMocks.getPersonalLineAccountById.mockResolvedValue({ ...ACCOUNT, bridge_base_url: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { db } = fakeDb();
    const res = await deliverToFriend(
      { DB: db } as unknown as Env['Bindings'],
      FRIEND,
      { type: 'text', content: 'hi' },
      { source: 'manual' },
    );
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bridge non-2xx → ok:false, no log', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    const { db, inserts } = fakeDb();
    const res = await deliverToFriend(
      { DB: db } as unknown as Env['Bindings'],
      FRIEND,
      { type: 'text', content: 'hi' },
      { source: 'manual' },
    );
    expect(res.ok).toBe(false);
    expect(inserts.find((q) => q.sql.includes('INSERT INTO messages_log'))).toBeUndefined();
  });
});
