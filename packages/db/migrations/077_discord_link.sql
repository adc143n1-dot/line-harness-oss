-- Migration 077: LINE↔Discord 同一人物紐付け (副業マッチング Phase C)
--
-- Telegram連携 (072) と全く同じ設計を踏襲する:
--   - 一度きり・有効期限付きの招待トークンでリンク (discord_invite_tokens)
--   - トークン自体を Discord OAuth2 の state パラメータとしてそのまま使い、
--     コールバック側は「token → friend_id」の解決とワンタイム消費を
--     同じ atomic UPDATE (used_at IS NULL AND revoked_at IS NULL AND
--     expires_at > now) で行う。署名付き state を別途発行する必要はない
--     (トークン自体がDB上のランダムな秘匿値であり、既にその役割を持つ)
--
-- Discord はTelegramのBot APIのような「Webhookでメッセージを受け取る」方式が
-- 使えない (Botのリアルタイム受信にはGatewayのWebSocket常時接続が必要で、
-- ステートレスなCloudflare Workersと相性が悪い)。代わりに標準のOAuth2
-- 認可コードフローを使う — これは既存の LINE Login / Google OAuth と同じ
-- 「ブラウザリダイレクト→コード交換」方式で、Workers上で完結する。

ALTER TABLE friends ADD COLUMN discord_user_id TEXT;
ALTER TABLE friends ADD COLUMN discord_verified_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_discord_user_id
  ON friends (discord_user_id) WHERE discord_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS discord_invite_tokens (
  token      TEXT PRIMARY KEY,
  friend_id  TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_discord_invite_tokens_friend_id ON discord_invite_tokens (friend_id);
