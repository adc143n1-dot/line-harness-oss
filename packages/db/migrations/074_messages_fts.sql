-- Migration 074: メッセージ本文の全文検索 (messages_fts)
--
-- 背景: messages_log には全文検索の前例が無い (FTS5・トリガーともゼロ)。
-- 友だち検索 (display_name への LIKE + ランク付け) はメッセージ本文には
-- 転用できない — 本文は自由文かつ既に数万行規模で、先頭ワイルドカードの
-- LIKE '%word%' はインデックスが効かず全表走査になる。
--
-- トークナイザは既定の unicode61 ではなく trigram を使う。日本語は単語間に
-- 空白が無いため、unicode61 は文全体を1トークンとして扱ってしまい部分一致
-- 検索が機能しない (実機検証済み)。trigram は3文字単位で重なり合う部分
-- 文字列をインデックスするため日本語の部分一致検索に対応できるが、
-- **検索クエリは3文字以上でないとヒットしない** という制約が伴う
-- (SQLite の trigram トークナイザは ngram サイズを変更できない)。
-- アプリ側 (検索API) で2文字以下のクエリを弾き、ユーザーに伝える。
--
-- 外部コンテンツ方式 (content_rowid で messages_log の rowid と同期) は、
-- messages_log.id が TEXT 主キーで暗黙 rowid との対応付けを間違えると
-- 壊れるため、このリポジトリで初めて導入するFTS5としてはリスクが高い。
-- 代わりに独立した FTS5 テーブルに id/friend_id/content を複製する。
-- ストレージは増えるが、実装・デバッグの安全性を優先する。
--
-- 同期は SQL トリガーではなく cron による追いつき方式 (messages-fts-sync.ts)。
-- messages_log への INSERT 箇所が複数ファイルに散らばっており、全箇所を
-- 改修するよりも、mileage キューや配信キューと同じ「多少遅れてよい・
-- 自己回復する」設計に寄せる方がリスクが低い。
--
-- 注意: D1 (Cloudflare) が trigram トークナイザを実際にサポートしているかは
-- ローカル検証 (SQLite 3.51.0) でのみ確認済み。本番D1へ適用後、実際に
-- INSERT + MATCH が動くことを早めに確認すること (SQLite 3.34+ で利用可能な
-- 機能のため動作するはずだが、D1側のビルドバージョンは未確認)。

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED,
  friend_id UNINDEXED,
  content,
  tokenize = 'trigram'
);
