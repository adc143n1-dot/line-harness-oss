-- 071 適用「前」に実行して、operators → staff_members の突合結果を確認する。
--   wrangler d1 execute <DB> --remote --file=packages/db/scripts/report-operator-merge.sql
-- matched_by が 'unmatched' の行は 071 で operator_id が NULL に落ちる。
SELECT
  c.id            AS chat_id,
  c.operator_id   AS current_operator_id,
  o.name          AS operator_name,
  o.email         AS operator_email,
  CASE
    WHEN o.id IS NULL THEN 'dangling'
    WHEN EXISTS (SELECT 1 FROM staff_members s
                  WHERE s.email IS NOT NULL AND o.email IS NOT NULL
                    AND lower(s.email) = lower(o.email)) THEN 'email'
    WHEN EXISTS (SELECT 1 FROM staff_members s WHERE s.name = o.name) THEN 'name'
    ELSE 'unmatched'
  END             AS matched_by
FROM chats c
LEFT JOIN operators o ON o.id = c.operator_id
WHERE c.operator_id IS NOT NULL
ORDER BY matched_by, c.id;
