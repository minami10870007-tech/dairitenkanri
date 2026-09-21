// GAS の API を最小限だけ模した環境でサーバー側ロジックを試す
const fs = require('fs');
const vm = require('vm');

function makeSheet(name) {
  const data = []; // 2次元配列（1行目=見出し）
  const ensure = (rows, cols) => {
    while (data.length < rows) data.push([]);
    for (const row of data) while (row.length < cols) row.push('');
  };
  const sheet = {
    getName: () => name,
    getMaxRows: () => Math.max(data.length, 1),
    getLastRow: () => data.length,
    setFrozenRows: () => sheet,
    appendRow: (values) => { data.push(values.slice()); return sheet; },
    deleteRow: (r) => { data.splice(r - 1, 1); return sheet; },
    getRange: (row, col, numRows = 1, numCols = 1) => ({
      setValues: (values) => {
        ensure(row + numRows - 1, col + numCols - 1);
        values.forEach((v, i) => v.forEach((cell, j) => { data[row - 1 + i][col - 1 + j] = cell; }));
        return { setFontWeight: () => ({ setBackground: () => {} }) };
      },
      getValues: () => {
        ensure(row + numRows - 1, col + numCols - 1);
        return Array.from({ length: numRows }, (_, i) =>
          Array.from({ length: numCols }, (_, j) => data[row - 1 + i][col - 1 + j]));
      },
      setDataValidation: () => {},
      setFontWeight: () => ({ setBackground: () => {} }),
    }),
    _data: data,
  };
  return sheet;
}

const sheets = {};
const sandbox = {
  console,
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sheets[n] || null,
      insertSheet: (n) => (sheets[n] = makeSheet(n)),
      getUrl: () => 'https://docs.google.com/spreadsheets/d/dummy/edit',
    }),
    getUi: () => { throw new Error('no ui'); },
    newDataValidation: () => ({
      requireValueInList: () => ({ setAllowInvalid: () => ({ build: () => ({}) }) }),
    }),
  },
  LockService: { getDocumentLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    formatDate: (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} 00:00`,
  },
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  HtmlService: {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), sandbox);
module.exports = sandbox;
