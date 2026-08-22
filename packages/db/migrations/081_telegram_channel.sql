-- Migration 081: マルチチャネル対応の基盤 (Telegram チャット管理)。
--
-- 目的:
--   friends を「LINE専用」から「汎用連絡先」へ拡張し、Telegram 連絡先を
--   同じ chats / messages_log / 運用機能で扱えるようにする。
--
-- 設計上の判断 (重要):
--   当初は line_user_id の NOT NULL を解除 (テーブル再構築) する予定だったが、
--   D1 本番で DROP TABLE を含む再構築が {"D1_RESET_DO":true} で失敗する
--   (D1はDOバックのテーブル再構築を単一移行で通せない)。そこで再構築を避け、
--   **加算のみ**の移行に変更:
--     - line_user_id は NOT NULL のまま維持。
--     - Telegram連絡先は line_user_id に衝突しない合成ID
--       'tg:<telegram_account_id>:<telegram_user_id>' を入れる。
--       LINEの 'U...' と衝突せず、UNIQUE(line_user_id) が
--       (Bot, Telegramユーザー) の一意性も担保する。
--     - channel 列が真のチャネル識別子。LINE送信経路は channel='line' でガードする。
--   これにより DROP TABLE を使わず、列追加とインデックス入替だけで完了する。

-- 1. Telegram Bot アカウント (line_accounts のTelegram版、複数Bot) --------------
CREATE TABLE IF NOT EXISTS telegram_accounts (
  id             TEXT PRIMARY KEY,
  bot_token      TEXT NOT NULL,
  bot_username   TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  name           TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  country        TEXT,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_accounts_username ON telegram_accounts (bot_username);

-- 2. friends 加算列 (再構築なし) --------------------------------------------------
ALTER TABLE friends ADD COLUMN channel TEXT NOT NULL DEFAULT 'line';
ALTER TABLE friends ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE friends ADD COLUMN telegram_account_id TEXT;

-- 3. messages_log 加算列 --------------------------------------------------------
ALTER TABLE messages_log ADD COLUMN channel TEXT NOT NULL DEFAULT 'line';

-- 4. telegram一意性を複数Bot対応の複合に置換 (index入替はD1安全) ------------------
DROP INDEX IF EXISTS idx_friends_telegram_user_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_telegram_account_user
  ON friends (telegram_account_id, telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_friends_channel ON friends (channel);
