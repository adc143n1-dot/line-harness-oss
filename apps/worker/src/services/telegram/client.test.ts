import { describe, it, expect, vi } from 'vitest';
import { TelegramClient } from './client.js';

function okJson(result: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({ ok: true, result }),
    text: async () => '',
  } as unknown as Response;
}

describe('TelegramClient', () => {
  it('sendText posts to sendMessage with chat_id/text', async () => {
    const fetchMock = vi.fn(async () => okJson({ message_id: 1 }));
    const client = new TelegramClient('BOT123', fetchMock as unknown as typeof fetch);
    const ok = await client.sendText('555', 'hello');
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botBOT123/sendMessage');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ chat_id: '555', text: 'hello' });
  });

  it('sendPhoto passes photo URL and optional caption', async () => {
    const fetchMock = vi.fn(async () => okJson({ message_id: 2 }));
    const client = new TelegramClient('BOT123', fetchMock as unknown as typeof fetch);
    await client.sendPhoto('555', 'https://x/i.jpg', 'cap');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ chat_id: '555', photo: 'https://x/i.jpg', caption: 'cap' });
  });

  it('setWebhook registers url + secret and restricts to message updates', async () => {
    const fetchMock = vi.fn(async () => okJson(true));
    const client = new TelegramClient('BOT123', fetchMock as unknown as typeof fetch);
    await client.setWebhook('https://w/api/telegram/webhook/acc1', 'sekret');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botBOT123/setWebhook');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      url: 'https://w/api/telegram/webhook/acc1',
      secret_token: 'sekret',
      allowed_updates: ['message'],
    });
  });

  it('returns false on API error', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad' }) as unknown as Response);
    const client = new TelegramClient('BOT123', fetchMock as unknown as typeof fetch);
    expect(await client.sendText('1', 'x')).toBe(false);
  });

  it('fetchAndStorePhoto: getFile → download → R2 put → returns image refs', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/getFile')) return okJson({ file_path: 'photos/f.jpg' });
      // file download
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'image/jpeg' }),
        arrayBuffer: async () => bytes,
      } as unknown as Response;
    });
    const put = vi.fn(async () => {});
    const r2 = { put } as unknown as R2Bucket;
    const client = new TelegramClient('BOT123', fetchMock as unknown as typeof fetch);

    const refs = await client.fetchAndStorePhoto({
      r2,
      workerUrl: 'https://w/',
      accountId: 'acc1',
      fileId: 'FID',
      fileUniqueId: 'UNIQ',
    });

    expect(refs).toEqual({
      originalContentUrl: 'https://w/images/incoming-tg-acc1-UNIQ.jpg',
      previewImageUrl: 'https://w/images/incoming-tg-acc1-UNIQ.jpg',
    });
    expect(put).toHaveBeenCalledOnce();
    const [key] = put.mock.calls[0];
    expect(key).toBe('incoming-tg-acc1-UNIQ.jpg');
  });
});
