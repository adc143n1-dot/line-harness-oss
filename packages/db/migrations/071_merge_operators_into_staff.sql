-- Migration 071: operators を廃止し、チャット担当者を staff_members に統合する。
--
-- 背景:
--   ログイン・権限は staff_members、チャット担当者は operators と人格が二重管理に
--   なっており、両者に紐付けが無かった。このため「自分の担当だけ表示」が原理的に
--   作れず、担当者を選んでもログイン中のスタッフとは無関係な行を指していた。
--
-- 実データについて:
--   管理画面は /api/operators を一度も呼んでおらず、operators 行を作る導線が存在
--   しない。したがって実データはほぼ空で chats.operator_id も大半が NULL である
--   想定。それでも行が存在する場合に備え、email → name の順で staff_members に
--   突合する。対応先が無いものは NULL に落とす (存在しないスタッフを指したまま
--   にするより、未割当として棚卸しさせる方が安全なため)。
--   移行前の突合結果は packages/db/scripts/report-operator-merge.sql で確認できる。
--
-- あわせて status の CHECK を拡張して 'waiting_reply' を許可する。
--   CHECK の変更にはテーブル再構築が必要で、外部キー変更と同時に行えば再構築が
--   1 回で済むため、ここでまとめている。値を書き込むアプリ側の対応は後続。

CREATE TABLE chats_new (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  operator_id   TEXT REFERENCES staff_members (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'in_progress', 'waiting_reply', 'resolved')),
  notes         TEXT,
  last_message_at TEXT,
  assigned_at       TEXT,
  first_response_at TEXT,
  resolved_at       TEXT,
  last_activity_at  TEXT,
  last_replied_by   TEXT CHECK (last_replied_by IN ('operator', 'user')),
  version           INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO chats_new (
  id, friend_id, operator_id, status, notes, last_message_at,
  assigned_at, first_response_at, resolved_at, last_activity_at, last_replied_by, version,
  created_at, updated_at
)
SELECT
  c.id,
  c.friend_id,
  COALESCE(
    (SELECT s.id FROM staff_members s, operators o
      WHERE o.id = c.operator_id
        AND s.email IS NOT NULL AND o.email IS NOT NULL
        AND lower(s.email) = lower(o.email)
      LIMIT 1),
    (SELECT s.id FROM staff_members s, operators o
      WHERE o.id = c.operator_id
        AND s.name = o.name
      LIMIT 1)
  ),
  c.status,
  c.notes,
  c.last_message_at,
  c.assigned_at,
  c.first_response_at,
  c.resolved_at,
  c.last_activity_at,
  c.last_replied_by,
  c.version,
  c.created_at,
  c.updated_at
FROM chats c;

DROP TABLE chats;

ALTER TABLE chats_new RENAME TO chats;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_friend_unique ON chats (friend_id);
CREATE INDEX IF NOT EXISTS idx_chats_operator ON chats (operator_id);
CREATE INDEX IF NOT EXISTS idx_chats_status ON chats (status);
CREATE INDEX IF NOT EXISTS idx_chats_last_activity ON chats (last_activity_at);

DROP TABLE operators;
