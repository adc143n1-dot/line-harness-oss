-- 複数スタッフでの有人チャット運用に向けた計測列と送信者記録。
--
-- messages_log.sent_by_staff_id:
--   手動送信を行ったスタッフ。自動応答・シナリオ配信・一斉配信は NULL のまま。
--   既存行は送信者不明のため NULL となる。
--
-- chats の計測列:
--   assigned_at / first_response_at / resolved_at は SLA と KPI の算出に使う。
--   last_activity_at / last_replied_by は放置検知に使う。
--   version は楽観ロック用。更新のたびに +1 する。
--   既存行は計測対象外として NULL のままにし、遡及補完はしない
--   (過去の送信者が特定できず、補完すると誤った KPI になるため)。
ALTER TABLE messages_log ADD COLUMN sent_by_staff_id TEXT REFERENCES staff_members (id) ON DELETE SET NULL;

ALTER TABLE chats ADD COLUMN assigned_at TEXT;
ALTER TABLE chats ADD COLUMN first_response_at TEXT;
ALTER TABLE chats ADD COLUMN resolved_at TEXT;
ALTER TABLE chats ADD COLUMN last_activity_at TEXT;
ALTER TABLE chats ADD COLUMN last_replied_by TEXT CHECK (last_replied_by IN ('operator', 'user'));
ALTER TABLE chats ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_log_sent_by_staff ON messages_log(sent_by_staff_id);
CREATE INDEX IF NOT EXISTS idx_chats_last_activity ON chats(last_activity_at);
