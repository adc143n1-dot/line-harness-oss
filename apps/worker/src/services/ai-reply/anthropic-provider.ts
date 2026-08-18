import type { AiReplyProvider, AiReplyRequest } from './provider.js';

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 400;
// LINE への一次応答は速さが要る。Anthropic API 自体が詰まっても webhook 処理を
// 長時間ブロックしないよう、ここで独立にタイムアウトさせる。
const REQUEST_TIMEOUT_MS = 15_000;

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
};

export class AnthropicProvider implements AiReplyProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
  ) {}

  async generateReply(request: AiReplyRequest): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: request.systemPrompt,
          messages: request.history.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Anthropic API error: ${res.status} ${detail}`);
      }

      const data = (await res.json()) as AnthropicResponse;
      const text = data.content?.find((block) => block.type === 'text')?.text?.trim();
      if (!text) throw new Error('Anthropic API returned no text content');
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}
