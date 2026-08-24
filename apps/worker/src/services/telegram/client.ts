// Telegram Bot API クライアント (LineClient 相当)。
// 送信 (text/photo)、受信画像の取得→R2保存、webhook登録を扱う。
// bot ごとに token が違うため、インスタンスは token を保持する。

const API_BASE = 'https://api.telegram.org';

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface TelegramStoredImage {
  originalContentUrl: string;
  previewImageUrl: string;
}

export interface TelegramWebhookInfo {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

export class TelegramClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly botToken: string, fetcher?: typeof fetch) {
    // Cloudflare Workers では global fetch を `this.fetcher(...)` のように別の
    // レシーバー経由で呼ぶと "Illegal invocation" になる。グローバルを正しい
    // this で呼ぶラッパーを既定にする (テストは注入した fetcher をそのまま使う)。
    this.fetcher = fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      const res = await this.fetcher(`${API_BASE}/bot${this.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[telegram] ${method} failed:`, res.status, await res.text().catch(() => ''));
        return null;
      }
      const json = (await res.json()) as { ok: boolean; result?: T };
      return json.ok ? (json.result ?? null) : null;
    } catch (err) {
      console.error(`[telegram] ${method} error:`, err);
      return null;
    }
  }

  async sendText(chatId: string, text: string): Promise<boolean> {
    const r = await this.call('sendMessage', { chat_id: chatId, text });
    return r !== null;
  }

  /** photoUrl は公開URL (R2の /images/... 等) を渡す。Telegramがサーバー側で取得する。 */
  async sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<boolean> {
    const r = await this.call('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      ...(caption ? { caption } : {}),
    });
    return r !== null;
  }

  async setWebhook(url: string, secretToken: string): Promise<boolean> {
    const r = await this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
    });
    return r !== null;
  }

  /** Telegram側のWebフック状態(URL・保留件数・最終エラー等)。診断用。 */
  async getWebhookInfo(): Promise<TelegramWebhookInfo | null> {
    return this.call<TelegramWebhookInfo>('getWebhookInfo', {});
  }

  private async getFilePath(fileId: string): Promise<string | null> {
    const r = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    return r?.file_path ?? null;
  }

  /**
   * 受信写真を取得して R2 に保存し、既存の image レンダラが使う
   * {originalContentUrl, previewImageUrl} 形状で返す。失敗時は null。
   */
  async fetchAndStorePhoto(opts: {
    r2: R2Bucket;
    workerUrl: string;
    accountId: string;
    fileId: string;
    fileUniqueId: string;
  }): Promise<TelegramStoredImage | null> {
    const filePath = await this.getFilePath(opts.fileId);
    if (!filePath) return null;

    let res: Response;
    try {
      res = await this.fetcher(`${API_BASE}/file/bot${this.botToken}/${filePath}`);
    } catch (err) {
      console.error('[telegram] file download failed', err);
      return null;
    }
    if (!res.ok) return null;

    const pathExt = (filePath.split('.').pop() ?? '').toLowerCase();
    const ext = EXT_TO_CONTENT_TYPE[pathExt] ? pathExt : 'jpg';
    const contentType =
      res.headers.get('Content-Type')?.split(';')[0].trim() || EXT_TO_CONTENT_TYPE[ext] || 'image/jpeg';
    // content-type から拡張子を補正 (Telegram の file_path が拡張子を持たない場合の保険)
    const finalExt = CONTENT_TYPE_TO_EXT[contentType] ?? ext;

    let data: ArrayBuffer;
    try {
      data = await res.arrayBuffer();
    } catch {
      return null;
    }

    const safeAccountId = opts.accountId.replace(/[^a-zA-Z0-9-]/g, '_');
    const safeFileId = opts.fileUniqueId.replace(/[^a-zA-Z0-9-]/g, '_');
    const key = `incoming-tg-${safeAccountId}-${safeFileId}.${finalExt}`;

    try {
      await opts.r2.put(key, data, { httpMetadata: { contentType } });
    } catch (err) {
      console.error('[telegram] R2 put failed', err);
      return null;
    }

    const base = opts.workerUrl.replace(/\/$/, '');
    const url = `${base}/images/${key}`;
    return { originalContentUrl: url, previewImageUrl: url };
  }
}
