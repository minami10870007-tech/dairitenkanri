/**
 * 紹介者管理アプリ（Google スプレッドシート + Google Apps Script）
 *
 * スプレッドシートの「紹介者」シートを1件=1行のデータベースとして使い、
 * 登録・検索・ステータス変更・削除・集計をブラウザの画面から行う。
 */

/** データを保存するシート名 */
const SHEET_NAME = '紹介者';

/** シート1行目の見出し（この順番が列の順番になる） */
const HEADERS = ['ID', '登録日', '紹介者名', '電話番号', 'メール', '被紹介者', 'ステータス', '備考', '更新日'];

/** ステータスの選択肢 */
const STATUSES = ['未対応', '対応中', '成約', '見送り'];

/* -------------------------------------------------------------------------
 * 画面の入り口
 * ---------------------------------------------------------------------- */

/** スプレッドシートを開いたときにカスタムメニューを追加する */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('紹介者管理')
    .addItem('アプリを開く', 'openApp')
    .addSeparator()
    .addItem('初期セットアップ（シート作成）', 'setup')
    .addToUi();
}

/** スプレッドシート内のダイアログでアプリを開く */
function openApp() {
  const html = HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('紹介者管理')
    .setWidth(900)
    .setHeight(650);
  SpreadsheetApp.getUi().showModalDialog(html, '紹介者管理');
}

/** ウェブアプリとして公開したときの入り口 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('紹介者管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** HTML から別ファイルを読み込むためのヘルパー */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* -------------------------------------------------------------------------
 * セットアップ
 * ---------------------------------------------------------------------- */

/**
 * 「紹介者」シートを作り、見出し行と入力規則を整える。
 * 既にシートがある場合は見出しと書式だけ整え直す（データは消さない）。
 */
function setup() {
  const sheet = initSheet_(getSheet_());
  const ui = getUi_();
  if (ui) {
    ui.alert('セットアップ完了', '「' + sheet.getName() + '」シートを準備しました。', ui.ButtonSet.OK);
  }
  return sheet.getName();
}

/** データシートを取得する（無ければ作成して整える） */
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  return sheet ? sheet : initSheet_(ss.insertSheet(SHEET_NAME));
}

/** 見出し行と入力規則を整える */
function initSheet_(sheet) {
  // 見出し行
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold')
    .setBackground('#f1f3f4');
  sheet.setFrozenRows(1);

  // ステータス列はプルダウンにする
  const statusCol = HEADERS.indexOf('ステータス') + 1;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, statusCol, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);

  return sheet;
}

/** UI が使える状況（スプレッドシートから実行）なら Ui を返す */
function getUi_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    return null; // ウェブアプリやトリガーからの実行時
  }
}

/* -------------------------------------------------------------------------
 * 画面から呼ばれる API
 * ---------------------------------------------------------------------- */

/** 画面の初期表示に必要な情報を返す */
function getConfig() {
  return {
    statuses: STATUSES,
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl()
  };
}

/**
 * 紹介者の一覧を返す。
 * @param {string} query キーワード（紹介者名・被紹介者・電話・メール・備考を部分一致で検索）
 * @param {string} status ステータスで絞り込み（空なら全件）
 * @return {Object[]} 新しい登録が先頭に来る配列
 */
function listReferrers(query, status) {
  const rows = readAll_();
  const keyword = String(query || '').trim().toLowerCase();
  const wanted = String(status || '').trim();

  return rows
    .filter(function (row) {
      if (wanted && row.ステータス !== wanted) return false;
      if (!keyword) return true;
      return ['紹介者名', '被紹介者', '電話番号', 'メール', '備考', 'ID'].some(function (key) {
        return String(row[key] || '').toLowerCase().indexOf(keyword) !== -1;
      });
    })
    .reverse();
}

/**
 * 紹介者を1件追加する。
 * @param {Object} form 紹介者名・電話番号・メール・被紹介者・ステータス・備考
 * @return {Object} 追加した行
 */
function addReferrer(form) {
  const input = form || {};
  const name = String(input.紹介者名 || '').trim();
  if (!name) {
    throw new Error('紹介者名は必須です。');
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    const now = new Date();
    const record = {
      ID: nextId_(sheet),
      登録日: now,
      紹介者名: name,
      電話番号: String(input.電話番号 || '').trim(),
      メール: String(input.メール || '').trim(),
      被紹介者: String(input.被紹介者 || '').trim(),
      ステータス: normalizeStatus_(input.ステータス),
      備考: String(input.備考 || '').trim(),
      更新日: now
    };
    sheet.appendRow(HEADERS.map(function (header) { return record[header]; }));
    return toPlain_(record);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 既存の1件を更新する。
 * @param {string} id 更新する行の ID
 * @param {Object} form 更新したい項目だけを入れたオブジェクト
 */
function updateReferrer(id, form) {
  const input = form || {};
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    const rowNumber = findRowNumber_(sheet, id);
    const current = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];

    HEADERS.forEach(function (header, index) {
      if (header === 'ID' || header === '登録日' || header === '更新日') return;
      if (!Object.prototype.hasOwnProperty.call(input, header)) return;
      current[index] = header === 'ステータス'
        ? normalizeStatus_(input[header])
        : String(input[header] || '').trim();
    });

    if (!String(current[HEADERS.indexOf('紹介者名')] || '').trim()) {
      throw new Error('紹介者名は必須です。');
    }
    current[HEADERS.indexOf('更新日')] = new Date();

    sheet.getRange(rowNumber, 1, 1, HEADERS.length).setValues([current]);
    return toPlain_(rowToObject_(current));
  } finally {
    lock.releaseLock();
  }
}

/** ステータスだけを変更する（一覧のプルダウン用） */
function updateStatus(id, status) {
  return updateReferrer(id, { 'ステータス': status });
}

/** 1件削除する */
function deleteReferrer(id) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    sheet.deleteRow(findRowNumber_(sheet, id));
    return { deleted: id };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 紹介者ごとの件数を集計する。
 * @return {Object} total（全件数）、byStatus（ステータス別件数）、byReferrer（紹介者別の明細）
 */
function getSummary() {
  const rows = readAll_();
  const byStatus = {};
  STATUSES.forEach(function (status) { byStatus[status] = 0; });

  const map = {};
  rows.forEach(function (row) {
    const status = row.ステータス || '未対応';
    byStatus[status] = (byStatus[status] || 0) + 1;

    const name = row.紹介者名 || '(未入力)';
    if (!map[name]) {
      map[name] = { 紹介者名: name, 件数: 0, 成約: 0, 対応中: 0, 未対応: 0, 見送り: 0 };
    }
    map[name].件数 += 1;
    if (Object.prototype.hasOwnProperty.call(map[name], status)) {
      map[name][status] += 1;
    }
  });

  const byReferrer = Object.keys(map)
    .map(function (name) { return map[name]; })
    .sort(function (a, b) { return b.件数 - a.件数 || a.紹介者名.localeCompare(b.紹介者名); });

  return { total: rows.length, byStatus: byStatus, byReferrer: byReferrer };
}

/* -------------------------------------------------------------------------
 * 内部処理
 * ---------------------------------------------------------------------- */

/** シート全体をオブジェクトの配列として読み込む */
function readAll_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  return sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues()
    .filter(function (row) { return String(row[HEADERS.indexOf('ID')] || '').trim() !== ''; })
    .map(function (row) { return toPlain_(rowToObject_(row)); });
}

/** 1行分の配列をオブジェクトに変換する */
function rowToObject_(row) {
  const record = {};
  HEADERS.forEach(function (header, index) { record[header] = row[index]; });
  return record;
}

/** Date をそのまま返すと画面側で扱いにくいので文字列に整える */
function toPlain_(record) {
  const plain = {};
  HEADERS.forEach(function (header) {
    const value = record[header];
    plain[header] = value instanceof Date ? formatDate_(value) : (value === null || value === undefined ? '' : String(value));
  });
  return plain;
}

/** yyyy/MM/dd HH:mm 形式に整形する */
function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
}

/** 次の ID（R0001 形式）を作る */
function nextId_(sheet) {
  const lastRow = sheet.getLastRow();
  let max = 0;
  if (lastRow >= 2) {
    sheet.getRange(2, HEADERS.indexOf('ID') + 1, lastRow - 1, 1).getValues().forEach(function (row) {
      const matched = /^R(\d+)$/.exec(String(row[0] || '').trim());
      if (matched) {
        max = Math.max(max, Number(matched[1]));
      }
    });
  }
  return 'R' + ('0000' + (max + 1)).slice(-4);
}

/** ID から行番号を探す */
function findRowNumber_(sheet, id) {
  const target = String(id || '').trim();
  if (!target) throw new Error('ID が指定されていません。');

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, HEADERS.indexOf('ID') + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === target) {
        return i + 2; // 見出し行の分を足す
      }
    }
  }
  throw new Error('ID「' + target + '」のデータが見つかりません。');
}

/** 未知のステータスが来たら既定値にそろえる */
function normalizeStatus_(status) {
  const value = String(status || '').trim();
  return STATUSES.indexOf(value) !== -1 ? value : STATUSES[0];
}
