import { Hono } from 'hono';
import { guideToMarkdown } from '@line-crm/shared';
import { getLineAccountById } from '@line-crm/db';
import { buildProvider } from '../services/ai-reply/index.js';
import type { AiReplyMessage } from '../services/ai-reply/provider.js';
import { buildOperationsSnapshot } from '../services/advisor.js';
import type { Env } from '../index.js';

const assistant = new Hono<Env>();

// 直近何ターンをモデルに渡すか (トークン抑制)。1ターン=1メッセージ。
const MAX_HISTORY_MESSAGES = 12;

// 回答内リンク用の「画面名 → パス」一覧。AIにはこの値だけを使わせる (未知パス禁止)。
const SCREEN_LINKS: { label: string; path: string }[] = [
  { label: '未対応', path: '/notifications' },
  { label: '個別チャット', path: '/chats' },
  { label: 'チャットボード', path: '/board' },
  { label: 'チーム状況', path: '/team' },
  { label: '友だち管理', path: '/friends' },
  { label: 'タグ管理', path: '/tags' },
  { label: 'シナリオ配信', path: '/scenarios' },
  { label: '一斉配信', path: '/broadcasts' },
  { label: 'テンプレート', path: '/templates' },
  { label: '自動返信ルール', path: '/auto-replies' },
  { label: 'オートメーション', path: '/automations' },
  { label: 'リマインダ', path: '/reminders' },
  { label: 'CV計測', path: '/conversions' },
  { label: 'マイル', path: '/scoring' },
  { label: '副業マッチングリード', path: '/job-matching-leads' },
  { label: 'リッチメニュー', path: '/rich-menus' },
  { label: 'Telegramアカウント', path: '/telegram-accounts' },
  { label: 'LINEアカウント', path: '/accounts' },
  { label: '運用ガイド', path: '/guide' },
];

const ASSISTANT_SYSTEM_PROMPT_HEADER = `あなたはこのLINE/Telegram顧客管理システムの管理画面に組み込まれたAIアシスタントです。
オペレーター(スタッフ)からの質問に、日本語で簡潔かつ具体的に答えてください。

できること:
- 画面の使い方・操作手順の案内(下記「管理画面の使い方」を根拠にする)
- 現状データの集計・要約・分析(下記「現在の運用データ」を根拠にする)
- 次にやるべきことの提案

守ること:
- 事実に基づき、数値を引用する。推測で断定しない。
- 根拠資料に無い機能を「ある」と言わない。分からないことは「この情報からは分かりません」と述べる。
- 箇条書きや短い見出しで読みやすく。前置きは最小限に。
- 個人の生データを列挙せず、集計・傾向として答える。
- 操作を促すときは、下記「画面リンク一覧」にあるものだけを Markdown リンク [ラベル](/パス) の形で示す。一覧に無い画面はリンクにしない。`;

function buildSystemPrompt(snapshot: string, accountName: string | null): string {
  const guide = guideToMarkdown({ compact: true });
  const links = SCREEN_LINKS.map((l) => `- ${l.label}: ${l.path}`).join('\n');
  return [
    ASSISTANT_SYSTEM_PROMPT_HEADER,
    '',
    `分析対象アカウント: ${accountName ?? '全アカウント合計(特定アカウント未選択)'}`,
    '',
    '========== 画面リンク一覧 (ラベル: パス) ==========',
    links,
    '',
    '========== 管理画面の使い方 ==========',
    guide,
    '',
    '========== 現在の運用データ ==========',
    snapshot,
  ].join('\n');
}

function sanitizeHistory(raw: unknown): AiReplyMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AiReplyMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      out.push({ role, content });
    }
  }
  // 直近 MAX_HISTORY_MESSAGES 件に制限
  return out.slice(-MAX_HISTORY_MESSAGES);
}

// POST /api/assistant/ask — 自由入力の質問に答える。ログイン済み全スタッフが利用可。
// ANTHROPIC_API_KEY があるときだけ動作 (advisor と同じ「人が押した時だけ課金」方針)。
assistant.post('/api/assistant/ask', async (c) => {
  const body = await c.req
    .json<{ question?: string; history?: unknown; accountId?: unknown }>()
    .catch((): { question?: string; history?: unknown; accountId?: unknown } => ({}));

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return c.json({ success: false, error: '質問を入力してください' }, 400);
  }

  const provider = buildProvider(c.env);
  if (!provider) {
    return c.json(
      { success: false, error: 'AIが未設定です。ANTHROPIC_API_KEY を登録すると利用できます。' },
      400,
    );
  }

  try {
    // 選択中アカウントに集計を絞る (未指定なら全体)。名称はスコープ明記に使う。
    const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined;
    let accountName: string | null = null;
    if (accountId) {
      const account = await getLineAccountById(c.env.DB, accountId);
      accountName = account ? account.name : null;
    }
    const snapshot = await buildOperationsSnapshot(c.env.DB, {
      lineAccountId: accountId,
      accountName: accountName ?? undefined,
    });
    const systemPrompt = buildSystemPrompt(snapshot, accountName);
    const history: AiReplyMessage[] = [
      ...sanitizeHistory(body.history),
      { role: 'user', content: question },
    ];

    const answer = await provider.generateReply({ systemPrompt, history, maxTokens: 1000 });
    return c.json({ success: true, data: { answer } });
  } catch (err) {
    console.error('POST /api/assistant/ask error:', err);
    return c.json({ success: false, error: 'AIの応答生成に失敗しました。しばらくして再度お試しください。' }, 500);
  }
});

export { assistant };
