import { getAccountSetting, setAccountSetting } from '@line-crm/db';

// messages_log -> messages_fts への同期。
//
// messages_log への INSERT は event-bus.ts / webhook.ts / chats.ts の送信
// ハンドラ / ai-reply など複数ファイルに散らばっている。全箇所を改修して
// FTS へ二重書き込みする代わりに、mileage キューや配信キューと同じ
// 「多少遅れてよい・自己回復する」設計に寄せ、cron で未索引行を追いつかせる。
//
// カーソル位置は新規テーブルを作らず、account_settings に
// line_account_id='__global__' の1行として持たせる (他の設定と同じ再利用パターン)。
//
// カーソルは (created_at, id) の複合値。created_at 単独の厳密比較 (>) だと、
// 同一ミリ秒に複数行がまとめて書き込まれた場合 (キュー配信のバッチ処理等)、
// 直前バッチの最後の行と同じ created_at を持つ後続行が永久にスキップされる。
// chats.ts の一覧ページング (beforeAt/beforeId) と同じ複合カーソルにして防ぐ。

const CURSOR_KEY = 'messages_fts_cursor';
const GLOBAL_SCOPE = '__global__';
const BATCH_SIZE = 500;

interface FtsCursor {
  createdAt: string;
  id: string;
}

interface UnsyncedRow {
  id: string;
  friend_id: string;
  content: string;
  created_at: string;
}

async function readCursor(db: D1Database): Promise<FtsCursor> {
  const raw = await getAccountSetting(db, GLOBAL_SCOPE, CURSOR_KEY);
  if (!raw) return { createdAt: '', id: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<FtsCursor>;
    return { createdAt: parsed.createdAt ?? '', id: parsed.id ?? '' };
  } catch {
    return { createdAt: '', id: '' };
  }
}

/**
 * 未索引の messages_log 行を最大 BATCH_SIZE 件 messages_fts へ複製し、
 * カーソルを進める。1回の呼び出しで1バッチ分だけ処理する
 * (毎分cronから呼ばれる想定。大量の遅延が溜まっても数分で追いつく)。
 *
 * 戻り値は処理件数。0 は「追いつき済み」を意味する。
 */
export async function syncMessagesFts(db: D1Database): Promise<number> {
  const cursor = await readCursor(db);

  const rows = await db
    .prepare(
      `SELECT id, friend_id, content, created_at FROM messages_log
        WHERE created_at > ? OR (created_at = ? AND id > ?)
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .bind(cursor.createdAt, cursor.createdAt, cursor.id, BATCH_SIZE)
    .all<UnsyncedRow>();

  if (rows.results.length === 0) return 0;

  // D1 バッチAPI で1トランザクションとして書き込む。
  const inserts = rows.results.map((row) =>
    db
      .prepare(`INSERT INTO messages_fts (id, friend_id, content) VALUES (?, ?, ?)`)
      .bind(row.id, row.friend_id, row.content),
  );
  await db.batch(inserts);

  const last = rows.results[rows.results.length - 1];
  await setAccountSetting(
    db,
    GLOBAL_SCOPE,
    CURSOR_KEY,
    JSON.stringify({ createdAt: last.created_at, id: last.id }),
  );

  return rows.results.length;
}
