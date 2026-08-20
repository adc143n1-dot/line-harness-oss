/**
 * 副業マッチング Phase B — Google Sheets CRM 連携用スクリプト。
 *
 * ● これは何か
 *   LINE Harness Worker がリード確定 (Q2回答完了) のたびに、このスクリプトを
 *   デプロイした Web App の URL へ JSON を POST してくる。受け取った内容を
 *   スプレッドシートの Members シートに1行ずつ追記する。
 *   併せて、毎朝のブリーフ・未対応リードのアラートも時間主導トリガーで送る。
 *
 * ● セットアップ手順 (Google側の作業。ここはユーザー自身で行ってください)
 *   1. 新しい Google スプレッドシートを作成する
 *   2. 「拡張機能」→「Apps Script」でスクリプトエディタを開く
 *   3. 中身をこのファイルの内容にまるごと置き換えて保存する
 *   4. 左メニューの「プロジェクトの設定」→「スクリプト プロパティ」で以下を追加:
 *        NOTIFY_EMAIL      : 通知を受け取りたいメールアドレス
 *        OVERDUE_HOURS     : (任意) HOTリードを「未対応」とみなす時間。未設定なら3時間
 *   5. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *        - 実行するユーザー: 自分
 *        - アクセスできるユーザー: 全員
 *      デプロイ後に発行される URL (.../exec で終わるもの) をコピーする
 *   6. Worker 側にそのURLをシークレットとして登録する:
 *        cd apps/worker
 *        npx wrangler secret put GOOGLE_SHEETS_WEBHOOK_URL
 *      (プロンプトが出たら 5. でコピーしたURLを貼り付ける)
 *   7. スクリプトエディタ左メニューの「トリガー」→「トリガーを追加」で以下を2つ登録:
 *        - 関数 morningBrief  / 時間主導型 / 日タイマー / 午前9時〜10時
 *        - 関数 checkOverdue  / 時間主導型 / 時間タイマー / 1時間おき
 *
 * ● シート構成 (Members シート。存在しなければ doPost が自動生成する)
 *   A:登録日時  B:リードID(LINEの友だちID)  C:名前  D:Q1回答  E:Q2回答
 *   F:スコア  G:温度  H:対応状況  I:対応日時
 *
 *   H列「対応状況」は、実際に連絡した担当者がスプレッドシート上で手動で
 *   「未対応」→「対応済み」に書き換える運用を想定している (このスクリプトは
 *   自動では書き換えない)。
 */

var SHEET_NAME = 'Members';
var HEADERS = ['登録日時', 'リードID', '名前', 'Q1回答', 'Q2回答', 'スコア', '温度', '対応状況', '対応日時'];
var STATUS_UNHANDLED = '未対応';
var STATUS_HANDLED = '対応済み';
var TEMPERATURE_LABEL = { hot: '🔥 HOT', warm: '🌤️ WARM', cold: '❄️ COLD' };

function getMembersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * LINE Harness Worker から呼ばれるエンドポイント。
 * 期待するリクエストボディ (JSON):
 *   { friendId, friendName, q1Label, q2Label, score, temperature, occurredAt }
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // 同時アクセスで行がずれないように直列化する
  try {
    var payload = JSON.parse(e.postData.contents);
    var sheet = getMembersSheet_();
    sheet.appendRow([
      payload.occurredAt || new Date().toISOString(),
      payload.friendId || '',
      payload.friendName || '',
      payload.q1Label || '',
      payload.q2Label || '',
      payload.score != null ? payload.score : '',
      payload.temperature || '',
      STATUS_UNHANDLED,
      '',
    ]);
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function getNotifyEmail_() {
  var email = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (!email) throw new Error('スクリプトプロパティ NOTIFY_EMAIL が未設定です');
  return email;
}

function getOverdueHours_() {
  var raw = PropertiesService.getScriptProperties().getProperty('OVERDUE_HOURS');
  var n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/** 前日1日分のリードをメールで要約する。日次トリガー (毎朝9時ごろ) 用。 */
function morningBrief() {
  var sheet = getMembersSheet_();
  var rows = sheet.getDataRange().getValues();
  rows.shift(); // ヘッダ行を除く

  var now = new Date();
  var yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  var counts = { hot: 0, warm: 0, cold: 0 };
  var hotNames = [];
  rows.forEach(function (row) {
    var occurredAt = new Date(row[0]);
    if (occurredAt < yesterdayStart || occurredAt >= todayStart) return;
    var temperature = row[6];
    if (counts[temperature] != null) counts[temperature]++;
    if (temperature === 'hot') hotNames.push(row[2] + ' (' + row[5] + '点)');
  });

  var total = counts.hot + counts.warm + counts.cold;
  var body =
    '昨日 (' + Utilities.formatDate(yesterdayStart, Session.getScriptTimeZone(), 'yyyy-MM-dd') + ') のリード概況\n\n' +
    '合計: ' + total + '件\n' +
    TEMPERATURE_LABEL.hot + ': ' + counts.hot + '件\n' +
    TEMPERATURE_LABEL.warm + ': ' + counts.warm + '件\n' +
    TEMPERATURE_LABEL.cold + ': ' + counts.cold + '件\n' +
    (hotNames.length > 0 ? '\nHOTリード:\n' + hotNames.join('\n') : '');

  MailApp.sendEmail(getNotifyEmail_(), '【副業マッチング】昨日のリード概況', body);
}

/**
 * HOTリードで一定時間 (既定3時間) 対応状況が「未対応」のままのものをアラートする。
 * 時間主導トリガー (1時間おき) 用。
 */
function checkOverdue() {
  var sheet = getMembersSheet_();
  var rows = sheet.getDataRange().getValues();
  rows.shift();

  var overdueMs = getOverdueHours_() * 60 * 60 * 1000;
  var now = new Date();
  var overdue = [];
  rows.forEach(function (row) {
    var temperature = row[6];
    var status = row[7];
    if (temperature !== 'hot' || status !== STATUS_UNHANDLED) return;
    var occurredAt = new Date(row[0]);
    if (now.getTime() - occurredAt.getTime() >= overdueMs) {
      overdue.push(row[2] + ' (' + row[5] + '点・登録 ' + Utilities.formatDate(occurredAt, Session.getScriptTimeZone(), 'MM/dd HH:mm') + ')');
    }
  });

  if (overdue.length === 0) return;

  var body =
    getOverdueHours_() + '時間以上「未対応」のままのHOTリードがあります。\n\n' +
    overdue.join('\n') +
    '\n\n対応後は Members シートの「対応状況」列を「' + STATUS_HANDLED + '」に更新してください。';

  MailApp.sendEmail(getNotifyEmail_(), '【副業マッチング】未対応HOTリードのアラート', body);
}
