-- Migration 081: マルチチャネル対応の基盤 (Telegram チャット管理)。
--
-- 目的:
--   friends を「LINE専用」から「汎用連絡先」へ拡張し、Telegram 連絡先を
--   同じ chats / messages_log / 運用機能で扱えるようにする。
--
-- 変更:
--   1. telegram_accounts テーブル新設 (line_accounts の Telegram 版、複数Bot)。
--   2. friends に channel / telegram_chat_id / telegram_account_id を追加。
--   3. messages_log に channel を追加。
--   4. friends.line_user_id の NOT NULL を解除 (Telegram連絡先は LINE id を持たない)。
--      SQLite は列の NOT NULL 解除を ALTER できないため、071 と同じテーブル再構築。
--
-- 再構築の安全性:
--   - 新列は先に ADD COLUMN してから再構築 SELECT で参照する。これにより bootstrap
--     等価テスト(schema.sql 先行適用済み → ADD COLUMN は benign 重複で無視)と本番
--     (旧 friends に列を足してから再構築)の双方で同じ最終形になる。
--   - 参照先 telegram_accounts を先に作成 (friends_new の FK 用)。
--   - FK は名前解決なので DROP/RENAME 後も他テーブルからの参照は維持される。

-- 1. Telegram Bot アカウント -------------------------------------------------
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

-- 2. friends 加算列 (再構築 SELECT が参照できるよう先に追加) -------------------
ALTER TABLE friends ADD COLUMN channel TEXT NOT NULL DEFAULT 'line';
ALTER TABLE friends ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE friends ADD COLUMN telegram_account_id TEXT;

-- 3. messages_log 加算列 -----------------------------------------------------
ALTER TABLE messages_log ADD COLUMN channel TEXT NOT NULL DEFAULT 'line';

-- 4. friends 再構築 (line_user_id の NOT NULL 解除 + channel CHECK + FK) --------
CREATE TABLE friends_new (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT UNIQUE,
  display_name     TEXT,
  picture_url      TEXT,
  status_message   TEXT,
  is_following     INTEGER NOT NULL DEFAULT 1,
  user_id          TEXT,
  ig_igsid         TEXT,
  score            INTEGER NOT NULL DEFAULT 0,
  last_ref_code    TEXT,
  last_ref_at      TEXT,
  first_followed_at TEXT,
  current_follow_started_at TEXT,
  last_followed_at TEXT,
  last_unfollowed_at TEXT,
  unfollow_count   INTEGER NOT NULL DEFAULT 0,
  source           TEXT,
  telegram_user_id TEXT,
  tg_verified_at   TEXT,
  channel             TEXT NOT NULL DEFAULT 'line' CHECK (channel IN ('line', 'telegram')),
  telegram_chat_id    TEXT,
  telegram_account_id TEXT REFERENCES telegram_accounts (id),
  q1_answer         TEXT,
  q2_answer         TEXT,
  q3_answer         TEXT,
  q4_answer         TEXT,
  lead_score        INTEGER,
  lead_temperature  TEXT CHECK (lead_temperature IN ('hot', 'warm', 'cold')),
  job_matching_conversation_state TEXT
    CHECK (job_matching_conversation_state IN ('awaiting_q1', 'awaiting_q2', 'diagnosed')),
  discord_user_id     TEXT,
  discord_verified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  ref_code         TEXT,
  metadata         TEXT NOT NULL DEFAULT '{}',
  line_account_id  TEXT REFERENCES line_accounts (id),
  first_tracked_link_id TEXT REFERENCES tracked_links (id) ON DELETE SET NULL
);

INSERT INTO friends_new (
  id, line_user_id, display_name, picture_url, status_message, is_following,
  user_id, ig_igsid, score, last_ref_code, last_ref_at, first_followed_at,
  current_follow_started_at, last_followed_at, last_unfollowed_at, unfollow_count,
  source, telegram_user_id, tg_verified_at, channel, telegram_chat_id, telegram_account_id,
  q1_answer, q2_answer, q3_answer, q4_answer, lead_score, lead_temperature,
  job_matching_conversation_state, discord_user_id, discord_verified_at,
  created_at, updated_at, ref_code, metadata, line_account_id, first_tracked_link_id
)
SELECT
  id, line_user_id, display_name, picture_url, status_message, is_following,
  user_id, ig_igsid, score, last_ref_code, last_ref_at, first_followed_at,
  current_follow_started_at, last_followed_at, last_unfollowed_at, unfollow_count,
  source, telegram_user_id, tg_verified_at, channel, telegram_chat_id, telegram_account_id,
  q1_answer, q2_answer, q3_answer, q4_answer, lead_score, lead_temperature,
  job_matching_conversation_state, discord_user_id, discord_verified_at,
  created_at, updated_at, ref_code, metadata, line_account_id, first_tracked_link_id
FROM friends;

DROP TABLE friends;
ALTER TABLE friends_new RENAME TO friends;

-- 索引再作成 (telegram_user_id 単独UNIQUE → (telegram_account_id, telegram_user_id) 複合に置換)
CREATE INDEX IF NOT EXISTS idx_friends_line_user_id ON friends (line_user_id);
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends (user_id);
CREATE INDEX IF NOT EXISTS idx_friends_ig_igsid ON friends (ig_igsid);
CREATE INDEX IF NOT EXISTS idx_friends_follow_tenure ON friends(is_following, current_follow_started_at);
CREATE INDEX IF NOT EXISTS idx_friends_source ON friends (source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_telegram_account_user
  ON friends (telegram_account_id, telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_friends_channel ON friends (channel);
CREATE INDEX IF NOT EXISTS idx_friends_lead_temperature ON friends (lead_temperature);
CREATE INDEX IF NOT EXISTS idx_friends_job_matching_state ON friends (job_matching_conversation_state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_discord_user_id
  ON friends (discord_user_id) WHERE discord_user_id IS NOT NULL;
