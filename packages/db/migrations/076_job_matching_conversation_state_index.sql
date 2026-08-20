-- 076: 副業マッチングリード一覧 (管理画面) の絞り込みを高速化するインデックス。
-- job_matching_conversation_state IS NOT NULL のフルスキャンを避ける。
CREATE INDEX IF NOT EXISTS idx_friends_job_matching_state ON friends (job_matching_conversation_state);
