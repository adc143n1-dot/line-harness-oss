# 引き継ぎガイド (HANDOFF)

> このファイルは「システムを初めて見る人がここから読めば全体を把握して開発を継続できる」ための入口です。
> 網羅的な仕様は既存の [README.md](README.md) と [docs/](docs/) を参照してください。ここでは
> **全体像・現在の状態・開発と運用の回し方・落とし穴** を、実際に動いている構成に即してまとめます。
> (最終整理: 2026-08-28)

---

## 1. これは何か(1分で)

LINE公式アカウント/Telegram/個人LINE を **1つの管理画面で統合的に運用する CRM + 配信 + 接客ツール**。

- **バックエンド**: Cloudflare Workers (Hono) + D1 (SQLite)。`apps/worker`
- **管理画面**: Next.js 15(静的エクスポート)。Cloudflare Pages 配信。`apps/web`
- **LIFF(LINE内Webアプリ)**: `apps/liff`
- **共有パッケージ**: `packages/*`(`@line-crm/db` `@line-crm/shared` `@line-crm/line-sdk` など)
- **モノレポ**: pnpm workspace

本番URL:
- Worker(API): `https://line-harness.adc143n1.workers.dev`
- 管理画面: `https://line-harness-admin-c1d.pages.dev`

---

## 2. リポジトリ構成

```
apps/
  worker/    Cloudflare Worker 本体(API・webhook受信・配信ディスパッチ)
    src/routes/       HTTPルート(chats, webhook, telegram, personal-line, ...)
    src/services/     ドメインロジック(messaging/dispatch, ai-reply, event-bus, ...)
    src/middleware/    認証・CSRF・IP許可・レート制限
    wrangler.toml     ★ account_id/database_id はプレースホルダ(CIが本番値を注入)
  web/       Next.js 管理画面(静的エクスポート)
    src/app/          画面(chats, telegram-accounts, personal-line-accounts, ...)
    src/lib/api.ts    APIクライアント(全エンドポイントの型付き入口)
  liff/      LIFF アプリ
packages/
  db/        D1 スキーマ(migrations/)+ 各テーブルのCRUD(src/*.ts)
  shared/    worker/web 共有の型・ロジック(ビルドが必要: pnpm --filter @line-crm/shared build)
  line-sdk/  LINE Messaging API クライアント(公式API。個人LINEには非対応)
.github/workflows/  CI/CD(deploy-cloudflare-worker / -admin / -pages, worker-ci)
docs/               詳細ドキュメント群
```

---

## 3. マルチチャネル設計(このシステムの中核)

「友だち(連絡先)」は `friends` テーブルで表し、`friends.channel` が真のチャネル識別子。
どのチャネルでも **同じ `chats` / `messages_log` / 運用機能(担当・自動返信・AI応答・CV等)** を共有する。

| チャネル | `channel` 値 | 受信 | 送信 | 状態 |
|---|---|---|---|---|
| LINE公式アカウント | `line` | Messaging API webhook `/webhook` | line-sdk push | ✅ 稼働 |
| Telegram | `telegram` | `/api/telegram/webhook/:accountId` | Bot API | ✅ 稼働 |
| 個人LINE(ブリッジ) | `personal_line` | `/api/personal-line/webhook/:accountId` | 外部ブリッジ `/send` | ⚠️ ハーネス側のみ完成(下記) |

**送信の一元化**: [apps/worker/src/services/messaging/dispatch.ts](apps/worker/src/services/messaging/dispatch.ts) の
`deliverToFriend()` が `friend.channel` で `sendLine` / `sendTelegram` / `sendPersonalLine` を出し分ける。
オペレーター送信・自動返信・AI応答すべてこれを共有。

**受信の共通形**: 各チャネルの webhook が `upsert〇〇Friend` → `messages_log`(`channel` 付き)→
`upsertChatOnMessage` → `fireEvent('message_received')` → テキスト自動化(自動返信+AI応答)。

**アカウント/認証情報テーブル**: `line_accounts` / `telegram_accounts` / `personal_line_accounts`
(秘匿列は平文。既存方針)。`friends` はチャネル別に合成ID方式で `line_user_id` を持つ
(`tg:<acc>:<user>` / `pl:<acc>:<user>`)。詳細は
[packages/db/migrations/081_telegram_channel.sql](packages/db/migrations/081_telegram_channel.sql) /
[082_personal_line_channel.sql](packages/db/migrations/082_personal_line_channel.sql) のコメント参照。

---

## 4. 現在の状態(done / pending)

**稼働中**
- LINE公式アカウント: 送受信・複数アカウント・配信・シナリオ・自動化・CV計測 など一式。
- Telegram: 送受信(text/画像)・複数Bot・自動返信・AI応答。設定は管理画面「Telegramアカウント」。
- 管理画面内AIアシスタント(選択アカウント別の集計・画面リンク・履歴保存)。
- チャットUI/UX(LINE/Telegram/個人LINE 統合の一覧+スレッド)。

**個人LINE(personal_line)= ハーネス側は完成、ブリッジ本体が未実装**
- 完成済み: DB(migration 082)・受信webhook・送信ディスパッチ・管理API・管理画面
  (設定→「個人LINE(ブリッジ)」)・チャット表示・**管理画面からの返信配線**。
- **未実装(=引き継ぎ後の作業)**: 個人LINEには公式APIが無いため、非公式クライアントを載せた
  **外部ブリッジサーバー(常時起動)** が必要。これは**意図的にハーネス外**。作り方は管理画面の
  「🛠 ブリッジサーバーの作り方」に最小構成コード付きで常設。実装が要るのは `send_line_message` と
  `receive_loop` の2関数のみ。
- ⚠️ 非公式クライアントは **LINE規約違反・アカウント凍結リスク** を伴う。運用の是非は要判断。
- 契約(HTTP): 受信=ブリッジ→`/api/personal-line/webhook/:id`(`X-Bridge-Secret`)、
  送信=ハーネス→`{bridge_base_url}/send`(`Authorization: Bearer`)。

---

## 5. ローカル開発・ビルド・テスト

前提: Node(このマシンは `~/.local/node/bin` にあり `export PATH="$HOME/.local/node/bin:$PATH"`)、pnpm。

```bash
pnpm install

# 型チェック / テスト(worker)
pnpm --filter worker typecheck
pnpm --filter worker test

# 共有パッケージを変更したら必ずビルド(worker の dist 解決が拾えるように)
pnpm --filter @line-crm/shared build

# 管理画面ビルド(本番APIを指す)
NEXT_PUBLIC_API_URL="https://line-harness.adc143n1.workers.dev" pnpm --filter web build
```

DBの型/CRUDは `packages/db`(ビルド不要・TSソース参照。`pnpm --filter @line-crm/db typecheck`)。

---

## 6. デプロイ(CI/CD)

`main` へ push すると GitHub Actions が自動デプロイ:
- **Deploy Cloudflare Worker**: D1マイグレーションを自動適用(`packages/db/migrations/*.sql` を順に、
  `_migrations` テーブルで未適用分だけ実行)→ Worker をデプロイ。
- **Deploy Cloudflare Admin** / **Deploy Cloudflare Pages**: 管理画面をデプロイ。
- **Worker CI**: 型チェック+テスト(デプロイとは別ジョブ)。

秘匿情報の扱い(重要):
- `apps/worker/wrangler.toml` の `account_id` / `database_id` は**プレースホルダをコミット**する。
  ローカルでは本物の値が入るが、**絶対にコミットしない**(`git restore --staged apps/worker/wrangler.toml`)。
- CIが `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` 等のSecrets、`ADMIN_ORIGIN` 等のVariablesを注入する。

---

## 7. 必要な秘匿情報 / 環境変数

一覧とテンプレートは [.env.example](.env.example)。Worker側は `wrangler secret put <NAME>`。主なもの:
- `API_KEY`(管理画面ログイン)、`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`、`WORKER_URL`
- `ADMIN_ORIGIN` / `ADMIN_ALLOW_CROSS_SITE`(Pages↔Workers クロスサイトのCookie/CORS)
- チャネル/機能別(.env.example に未記載のもの):
  - `TELEGRAM_WEBHOOK_SECRET`(旧・単一Bot紐付け用。複数Botは各 telegram_accounts.webhook_secret)
  - `ANTHROPIC_API_KEY`(AI応答・AIアシスタント。未設定ならAI機能は自動的に無効=フェイルセーフ)
- 管理画面(Pages): `NEXT_PUBLIC_API_URL`

---

## 8. 新しいチャネルを1つ足すときの手順(Telegram/個人LINEで確立したパターン)

雛形は常に **Telegram 実装**(routes/telegram.ts, telegram-accounts.ts, dispatch.ts の sendTelegram, db/telegram-accounts.ts, migration 081)。最小構成:

1. **DB**: 加算マイグレーション(`〇〇_accounts` テーブル + `friends` に列追加)。**DROP TABLE 不可**。
2. **DB層**: `packages/db/src/〇〇-accounts.ts` + `friends.ts` に `upsert〇〇Friend`(合成ID)。index.ts で re-export。
3. **送信**: `dispatch.ts` に `send〇〇` を追加し `deliverToFriend` の分岐に足す。
4. **受信**: `apps/worker/src/routes/〇〇.ts`(署名/secret検証 → upsert → messages_log → chat化 → イベント → 自動化)。`index.ts` でマウント。
5. **★認証除外**: `apps/worker/src/middleware/auth.ts` の公開パス除外リストに受信webhookを追加(でないとCSRFで403)。
6. **一覧のアカウント絞り**: `apps/worker/src/routes/chats.ts` の**2箇所**(accountFilterSql と page CTE conditions)に新channelを追加(でないとアカウント選択時に消える)。
7. **フロント**: `chats/page.tsx`(型ユニオン・ChannelBadge・フィルタ・行ドット・ヘッダー)、`api.ts`、管理画面ページ、`nav-items.ts`。

---

## 9. 落とし穴(既知・再発しやすい)

- **D1はテーブル再構築(DROP TABLE)を単一移行で通せない**(`D1_RESET_DO` 失敗)。マイグレーションは**加算のみ**。列のNOT NULL解除等は合成ID等で回避する。
- **チャネル追加時の「消える」罠**: `chats.ts` のアカウント絞りは**2箇所**ある。片方だけ直すとアカウント選択時に新チャネルが一覧から消える。
- **webhookのCSRF 403**: 外部からの受信は `middleware/auth.ts` の公開パス除外に入れる。ルート単体testでは気づけない結合の穴。
- **wrangler.toml の秘匿**: ローカルの本物値を絶対にコミットしない。
- **共有パッケージ**: `@line-crm/shared` を変更したら `pnpm --filter @line-crm/shared build` を忘れない。
- **個人LINEのブリッジ**は規約リスクを伴う外部要素。ハーネス本体の正当性とは切り離して扱う。

---

## 10. さらに詳しく

- 全体像・機能一覧・クイックスタート: [README.md](README.md)
- 管理画面認証: [docs/ADMIN-AUTH.md](docs/ADMIN-AUTH.md)
- LINE APIプロキシ: [docs/LINE-API-PROXY.md](docs/LINE-API-PROXY.md)
- コントリビュート/運用ルール: [CONTRIBUTING.md](CONTRIBUTING.md) / [AGENTS.md](AGENTS.md) / [SECURITY.md](SECURITY.md)
- 変更履歴: [CHANGELOG.md](CHANGELOG.md)
- 管理画面内「運用ガイド」(/guide)にも操作手順あり。
