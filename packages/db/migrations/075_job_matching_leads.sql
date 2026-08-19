-- Migration 075: 副業マッチング自動化システム — リード属性の追加 (Phase A)
--
-- 本人確認書類関連の列は追加しない。「スケール時にクライアント要件で必要に
-- なるかもしれない」という推測での要求だったため、実際に必要になった時点で
-- 契約直前など適切なタイミングに絞って追加する方針とした (要件確定前に
-- 個人情報を集める列だけ先に用意しない)。
--
-- conversation_state (Q1未回答/Q2未回答/診断済み) は新規テーブルを作らず
-- 既存の friends.metadata (汎用JSON列) に含める。

ALTER TABLE friends ADD COLUMN q1_answer TEXT;
ALTER TABLE friends ADD COLUMN q2_answer TEXT;
ALTER TABLE friends ADD COLUMN lead_score INTEGER;
ALTER TABLE friends ADD COLUMN lead_temperature TEXT CHECK (lead_temperature IN ('hot', 'warm', 'cold'));
-- 会話ステートマシンの進行状況。当初 friends.metadata に載せる想定だったが、
-- 実装前の裏取りで friends.metadata という列自体がこのスキーマに存在しない
-- ことが判明した (resolveMetadata() は user_id 経由で別テーブルから
-- メタデータをマージする関数で、friends 自体には無い)。誤った前提のまま
-- 実装せず、素直に専用列を足す。
ALTER TABLE friends ADD COLUMN job_matching_conversation_state TEXT
  CHECK (job_matching_conversation_state IN ('awaiting_q1', 'awaiting_q2', 'diagnosed'));

CREATE INDEX IF NOT EXISTS idx_friends_lead_temperature ON friends (lead_temperature);
