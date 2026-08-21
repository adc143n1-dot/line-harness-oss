-- Migration 078: マルチスタッフ運用の集計基盤 (チーム見える化 Phase 1)
--
-- 毎日200登録 × スタッフ10名規模を想定した「担当者別 × 状態別」の集計
-- (チームダッシュボード) と「本日解決数」の集計に備えるインデックス。
-- 既存は operator_id / status それぞれ単独のインデックスのみ (idx_chats_operator /
-- idx_chats_status) で、GROUP BY operator_id, status の複合集計には効かない。

CREATE INDEX IF NOT EXISTS idx_chats_operator_status ON chats (operator_id, status);
CREATE INDEX IF NOT EXISTS idx_chats_resolved_at ON chats (resolved_at) WHERE resolved_at IS NOT NULL;
