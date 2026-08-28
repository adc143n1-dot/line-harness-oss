-- Migration 082: 個人LINE(非公式ブリッジ)チャネルの受け皿。
--
-- 目的:
--   個人LINEアカウントの1対1トークを、既存の chats / messages_log / 運用機能で
--   扱えるようにする。個人LINEには公式APIが無いため、非公式クライアントを載せた
--   外部「ブリッジサーバー」を経由して送受信する。ハーネス側はブリッジと汎用HTTP
--   契約で繋ぐための受け皿(アカウント情報 + friends 加算列)だけを持つ。
--
-- 設計上の判断:
--   081 (Telegram) と同じ「加算のみ」の移行方針を厳守する。D1 は DROP TABLE を
--   含む再構築を単一移行で通せない (D1_RESET_DO 失敗) ため、テーブル再構築はしない。
--     - 個人LINE連絡先は line_user_id に衝突しない合成ID
--       'pl:<personal_line_account_id>:<personal_line_user_id>' を入れる。
--       LINEの 'U...' / Telegramの 'tg:...' と衝突せず、UNIQUE(line_user_id) が
--       (アカウント, 相手) の一意性も担保する。
--     - channel 列 (081で追加済み) に 'personal_line' を入れる。送信経路の分岐に使う。

-- 1. 個人LINEブリッジ・アカウント (line_accounts / telegram_accounts の個人LINE版) ----
--    bridge_base_url : ハーネスが送信時に POST する外部ブリッジの基点URL。
--    bridge_secret   : 送信(ハーネス→ブリッジ)の Bearer 認証に使う共有シークレット。
--    inbound_secret  : 受信(ブリッジ→ハーネス Webフック)の X-Bridge-Secret 照合用。
--    秘匿列は line_accounts の access token 同様の平文列方針 (既存踏襲)。
CREATE TABLE IF NOT EXISTS personal_line_accounts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  bridge_base_url TEXT,
  bridge_secret   TEXT NOT NULL,
  inbound_secret  TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- 2. friends 加算列 (再構築なし) --------------------------------------------------
ALTER TABLE friends ADD COLUMN personal_line_user_id TEXT;
ALTER TABLE friends ADD COLUMN personal_line_account_id TEXT;

-- 3. 個人LINEの一意性 (アカウント×相手mid の複合、部分UNIQUE) ----------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_personal_line_acct_user
  ON friends (personal_line_account_id, personal_line_user_id)
  WHERE personal_line_user_id IS NOT NULL;
