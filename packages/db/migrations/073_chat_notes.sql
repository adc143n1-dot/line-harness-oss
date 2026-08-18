-- Migration 073: 内部メモの時系列化 (chat_notes)
--
-- 背景: 既存の chats.notes は上書き式の1枚テキストで、複数スタッフが同時に
-- 対応する運用 (071 の operators 統合・Claim) が現実になった今、
-- 「書いた端から消し合う」問題がそのまま事故になる。
-- 誰が・いつ・何を書いたかを追記専用で残す。
--
-- 編集・削除は実装しない (監査性を優先し、権限まわりの複雑さを避ける)。
-- chats.notes 列はテーブル再構築を避けるためそのまま残すが、新しい UI からは
-- 参照しなくなる (事実上の非推奨)。

CREATE TABLE IF NOT EXISTS chat_notes (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  staff_id   TEXT REFERENCES staff_members (id) ON DELETE SET NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_chat_notes_chat_id ON chat_notes(chat_id, created_at);
