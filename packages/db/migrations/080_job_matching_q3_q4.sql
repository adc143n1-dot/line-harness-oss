-- Migration 080: 副業マッチング診断に Q3 (稼働できる時間帯)・Q4 (開始希望時期) を追加
--
-- 顧客データベース設計の第1段階。診断 (Q1/Q2→スコア確定) の後に、案件
-- マッチング精度向上のための追加2問を聞く。会話ステートは既存の CHECK 制約
-- (awaiting_q1/awaiting_q2/diagnosed) を変えず、'diagnosed' のまま
-- 「q3_answer/q4_answer が NULL かどうか」で進行を判定する (SQLite は
-- CHECK 制約の変更にテーブル再構築が必要なため、列の NULL 判定で代替)。

ALTER TABLE friends ADD COLUMN q3_answer TEXT;
ALTER TABLE friends ADD COLUMN q4_answer TEXT;
