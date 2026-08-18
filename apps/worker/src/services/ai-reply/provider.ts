/**
 * AI 自動応答のプロバイダ抽象。プロバイダを差し替えても呼び出し側
 * (maybeSendAiReply) を変更せずに済むよう、この形に固定する。
 */
export interface AiReplyMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiReplyRequest {
  systemPrompt: string;
  /** 直近の会話。最後の要素が今回の受信メッセージ */
  history: AiReplyMessage[];
  maxTokens?: number;
}

export interface AiReplyProvider {
  generateReply(request: AiReplyRequest): Promise<string>;
}
