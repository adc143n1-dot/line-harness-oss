-- Migration 079: チャットのスヌーズ (再連絡予約)
--
-- 「返信待ち」のまま放置されて忘れられる問題への対策。snooze_until を設定した
-- チャットは、その時刻を過ぎると cron が status='unread' に戻して再浮上させる
-- (担当は維持したまま)。解除処理は毎分 cron の1本のUPDATEで行うため、
-- 期限到達行だけを拾う部分インデックスを張る。

ALTER TABLE chats ADD COLUMN snooze_until TEXT;
CREATE INDEX IF NOT EXISTS idx_chats_snooze_until ON chats (snooze_until) WHERE snooze_until IS NOT NULL;
