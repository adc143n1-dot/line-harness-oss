import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthenticatedStaff } from '../middleware/auth.js';
import type { Env } from '../index.js';

vi.mock('@line-crm/db', () => ({
  getChats: vi.fn(),
  getChatById: vi.fn(async () => ({
    id: 'chat-1',
    friend_id: 'friend-1',
    operator_id: null,
    status: 'unread',
    notes: null,
    last_message_at: null,
    assigned_at: null,
    first_response_at: null,
    resolved_at: null,
    last_activity_at: null,
    last_replied_by: null,
    outcome: null,
    version: 0,
    created_at: '2026-08-19T10:00:00.000+09:00',
    updated_at: '2026-08-19T10:00:00.000+09:00',
  })),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(async () => true),
  jstNow: vi.fn(() => '2026-08-19T21:00:00.000+09:00'),
  toJstString: vi.fn((d: Date) => d.toISOString()),
  listChatNotes: vi.fn(),
  createChatNote: vi.fn(),
}));

import { listChatNotes, createChatNote } from '@line-crm/db';
import { chats } from './chats.js';

function fakeDb() {
  return {} as unknown as D1Database;
}

function app(staff?: AuthenticatedStaff) {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => {
    if (staff) c.set('staff', staff);
    await next();
  });
  a.route('/', chats);
  return a;
}

describe('GET /api/chats/:id/notes', () => {
  test('時系列順のメモをスタッフ名付きで返す', async () => {
    vi.mocked(listChatNotes).mockResolvedValue([
      { id: 'n1', chat_id: 'chat-1', staff_id: 's1', staff_name: 'Aoi', content: '要フォロー', created_at: '2026-08-19T10:00:00.000+09:00' },
      { id: 'n2', chat_id: 'chat-1', staff_id: null, staff_name: null, content: '自動記録', created_at: '2026-08-19T11:00:00.000+09:00' },
    ]);

    const res = await app().request('/api/chats/chat-1/notes', {}, { DB: fakeDb() } as unknown as Env['Bindings']);
    const body = (await res.json()) as { data: unknown };

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      { id: 'n1', content: '要フォロー', createdAt: '2026-08-19T10:00:00.000+09:00', staffId: 's1', staffName: 'Aoi' },
      { id: 'n2', content: '自動記録', createdAt: '2026-08-19T11:00:00.000+09:00', staffId: null, staffName: null },
    ]);
  });
});

describe('POST /api/chats/:id/notes', () => {
  async function post(body: unknown, staff?: AuthenticatedStaff) {
    vi.mocked(createChatNote).mockClear();
    return app(staff).request(
      '/api/chats/chat-1/notes',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { DB: fakeDb() } as unknown as Env['Bindings'],
    );
  }

  test('実在するスタッフの id を記録する', async () => {
    vi.mocked(createChatNote).mockResolvedValue({
      id: 'n1', chat_id: 'chat-1', staff_id: 'staff-7', staff_name: 'Aoi', content: '要フォロー', created_at: '2026-08-19T21:00:00.000+09:00',
    });

    const res = await post({ content: '要フォロー' }, { id: 'staff-7', name: 'Aoi', role: 'staff' });

    expect(res.status).toBe(200);
    expect(vi.mocked(createChatNote).mock.calls[0][1]).toMatchObject({ chatId: 'chat-1', staffId: 'staff-7', content: '要フォロー' });
  });

  test('共有 API キー (staffなし) では staffId=NULL で記録する', async () => {
    vi.mocked(createChatNote).mockResolvedValue({
      id: 'n1', chat_id: 'chat-1', staff_id: null, staff_name: null, content: '要フォロー', created_at: '2026-08-19T21:00:00.000+09:00',
    });

    await post({ content: '要フォロー' }, undefined);

    expect(vi.mocked(createChatNote).mock.calls[0][1]).toMatchObject({ staffId: null });
  });

  test('空文字は 400 で拒否する', async () => {
    const res = await post({ content: '   ' }, { id: 'staff-7', name: 'Aoi', role: 'staff' });
    expect(res.status).toBe(400);
    expect(createChatNote).not.toHaveBeenCalled();
  });
});
