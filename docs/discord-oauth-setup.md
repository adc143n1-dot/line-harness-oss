# Discord連携 (副業マッチング Phase C) セットアップ手順

LINE友だちとDiscordアカウントを紐付けるための、Discord Developer Portal側の設定手順です。ここはユーザー自身で行ってください(アカウント作成・外部サービスの設定は代行しない方針のため)。

## 1. Discordアプリケーションの作成

1. https://discord.com/developers/applications を開く
2. 「New Application」→ 任意の名前で作成
3. 左メニュー「OAuth2」→「General」を開く
4. **Client ID** と **Client Secret** をコピーしておく (Client Secretは「Reset Secret」で再発行も可能)

## 2. リダイレクトURLの登録

同じ「OAuth2」→「General」画面の「Redirects」に、以下を**完全一致**で追加してください。

```
https://<あなたのWorkerの公開URL>/discord/callback
```

例: `https://line-harness.adc143n1.workers.dev/discord/callback`

(Worker側の `WORKER_URL` 環境変数の値 + `/discord/callback` と一致している必要があります)

## 3. Worker側にシークレットを登録

```bash
cd apps/worker
npx wrangler secret put DISCORD_OAUTH_CLIENT_SECRET
# プロンプトで 1. でコピーした Client Secret を貼り付け
```

Client ID はシークレットではない (公開情報) ので、`wrangler.toml` の `[vars]` に直接書けます。

```toml
[vars]
# ...既存の設定...
DISCORD_OAUTH_CLIENT_ID = "ここに Client ID"
```

## 4. 動作確認

1. Workerを再デプロイ (`pnpm --filter worker run deploy`)
2. 管理画面の「個別チャット」で任意の友だちを開き、「💬 Discordに誘導する」ボタンを押す
3. その友だちのLINEに、Discordの認可画面へのリンクが届く
4. リンクを開いて認可すると、「✅ 連携が完了しました」ページが表示され、管理画面側も「✅ Discord連携済」バッジに変わる

## 補足: なぜBotではなくOAuth2なのか

Discordの通常のBot(リアルタイムのメッセージ受信・スラッシュコマンド等)は、Gateway APIというWebSocketの常時接続が必要です。Cloudflare Workersはステートレスな実行環境のため、この方式とは相性がよくありません。

そのため、このリポジトリでは「LINE友だち↔Discordユーザーの本人確認・紐付け」だけをOAuth2の認可コードフロー(ブラウザのリダイレクトのみで完結する、既存のLINE Login/Google連携と同じ方式)で行い、コミュニティ運営(ロール自動付与・レベリング・AutoMod等)は、Discord上で動く既製のBot(Carl-bot、MEE6等)に任せる設計にしています。
