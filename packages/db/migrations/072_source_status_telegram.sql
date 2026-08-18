-- Migration 072: 流入元トラッキング / 成果ステータス / LINE↔Telegram 紐付け
--
-- 1. friends.source
--    LINE 友だち追加時の referral (`lp=instagram` 等) から採取する流入元。
--    初回のみ記録し、後から上書きしない (再訪で流入元が塗り替わると
--    流入元別の成果が測れなくなるため)。
--
-- 2. chats.outcome
--    進行状態 (status) とは独立した「成果」。converted / lost / NULL。
--    進行状態・成果・顧客属性を 1 カラムに同居させると「VIP かつ 対応中」が
--    表現できず、片方を選ぶともう片方が失われる。このため次の 3 つに分ける:
--      進行状態 -> chats.status ('waiting_reply' は 071 で追加済み)
--      成果     -> chats.outcome (このマイグレーション)
--      顧客属性 -> 既存のタグ機構 (VIP は 'VIP' タグ。人単位の属性であり
--                  チャット単位ではないため、チャットが変わっても付け直し不要)
--
-- 3. Telegram 紐付け
--    friends.telegram_user_id は 1 人の Telegram ユーザーが複数の LINE 友だちに
--    紐付かないよう部分 UNIQUE インデックスを張る (NULL は重複可)。
--    tg_invite_tokens は招待トークンのワンタイム管理。expires_at を必須にして
--    いるのは、期限なしのトークンが LINE のトーク履歴に残り続けると、
--    実質的に失効しないアカウント紐付け用の認証情報になるため。

ALTER TABLE friends ADD COLUMN source TEXT;
ALTER TABLE friends ADD COLUMN telegram_user_id TEXT;
ALTER TABLE friends ADD COLUMN tg_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_friends_source ON friends (source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_telegram_user_id
  ON friends (telegram_user_id) WHERE telegram_user_id IS NOT NULL;

ALTER TABLE chats ADD COLUMN outcome TEXT CHECK (outcome IN ('converted', 'lost'));

CREATE TABLE IF NOT EXISTS tg_invite_tokens (
  token      TEXT PRIMARY KEY,
  friend_id  TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tg_invite_tokens_friend_id ON tg_invite_tokens (friend_id);
