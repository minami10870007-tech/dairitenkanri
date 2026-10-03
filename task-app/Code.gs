/**
 * めっちゃ簡単なタスク管理アプリ（Google スプレッドシート + GAS）
 *
 * 「タスク」シートを1件=1行のデータベースとして使う。
 * できること：追加 / 完了・未完了の切り替え / 削除 / 一覧表示
 */

const TASK_SHEET = 'タスク';
const TASK_HEADERS = ['ID', 'タスク', '期限', '完了', '作成日'];

/** スプレッドシートを開いたときにメニューを出す */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('タスク管理')
    .addItem('アプリを開く', 'openTaskApp')
    .addToUi();
}

/** スプレッドシート上にダイアログで開く */
function openTaskApp() {
  const html = HtmlService.createHtmlOutputFromFile('index').setWidth(520).setHeight(640);
  SpreadsheetApp.getUi().showModelessDialog(html, 'タスク管理');
}

/** ウェブアプリとして開く（デプロイした URL でスマホからも使える） */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('タスク管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** シートを取得（無ければ見出し付きで作る） */
function getTaskSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TASK_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TASK_SHEET);
    sheet.getRange(1, 1, 1, TASK_HEADERS.length).setValues([TASK_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 日付セルを "yyyy-MM-dd" の文字列にそろえる（Date はそのまま画面に返せないため） */
function toDateText_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return value ? String(value) : '';
}

/** 一覧を返す（未完了→期限が近い順） */
function listTasks() {
  const sheet = getTaskSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, TASK_HEADERS.length).getValues();
  return rows
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) {
      return {
        id: String(r[0]),
        title: String(r[1]),
        due: toDateText_(r[2]),
        done: r[3] === true || r[3] === 'TRUE',
        created: toDateText_(r[4]),
      };
    })
    .sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99');
    });
}

/** 追加 */
function addTask(title, due) {
  title = String(title || '').trim();
  if (!title) throw new Error('タスク名を入力してください。');
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const id = Utilities.getUuid().slice(0, 8);
    // 期限は先頭に ' を付けて文字列のまま保存（勝手に日付型にされないように）
    getTaskSheet_().appendRow([id, title, due ? "'" + due : '', false, new Date()]);
  } finally {
    lock.releaseLock();
  }
  return listTasks();
}

/** 完了 / 未完了を切り替え */
function toggleTask(id) {
  const row = findRow_(id);
  const cell = getTaskSheet_().getRange(row, 4);
  cell.setValue(cell.getValue() !== true);
  return listTasks();
}

/** 削除 */
function deleteTask(id) {
  getTaskSheet_().deleteRow(findRow_(id));
  return listTasks();
}

/** ID から行番号を探す */
function findRow_(id) {
  const sheet = getTaskSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) return i + 2;
    }
  }
  throw new Error('タスクが見つかりません（別の画面で削除された可能性があります）。');
}
