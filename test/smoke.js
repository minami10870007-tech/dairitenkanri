const s = require('./gas-stub.js');
const assert = require('assert');

s.setup();
assert.strictEqual(s.listReferrers('', '').length, 0, '初期状態は空');

const a = s.addReferrer({ '紹介者名': '山田 太郎', '電話番号': '090-1111-2222', 'メール': 'taro@example.com', '被紹介者': '株式会社A 鈴木様', '備考': 'セミナー経由' });
const b = s.addReferrer({ '紹介者名': '山田 太郎', '被紹介者': '株式会社B 佐藤様', 'ステータス': '成約' });
const c = s.addReferrer({ '紹介者名': '佐々木 花子', '被紹介者': '個人 田中様', 'ステータス': 'おかしな値' });
assert.strictEqual(a.ID, 'R0001');
assert.strictEqual(b.ID, 'R0002');
assert.strictEqual(c.ステータス, '未対応', '不正なステータスは既定値に寄せる');
assert.strictEqual(b.ステータス, '成約');

// 必須チェック
assert.throws(() => s.addReferrer({ '紹介者名': '  ' }), /紹介者名は必須/);

// 一覧は新しい順
const all = s.listReferrers('', '');
assert.strictEqual(JSON.stringify(Array.from(all.map(r => r.ID))), JSON.stringify(['R0003', 'R0002', 'R0001']));

// 検索
assert.strictEqual(JSON.stringify(Array.from(s.listReferrers('山田', '').map(r => r.ID))), JSON.stringify(['R0002', 'R0001']));
assert.strictEqual(JSON.stringify(Array.from(s.listReferrers('taro@example', '').map(r => r.ID))), JSON.stringify(['R0001']));
assert.strictEqual(JSON.stringify(Array.from(s.listReferrers('株式会社b', '').map(r => r.ID))), JSON.stringify(['R0002']), '大文字小文字を区別しない');
assert.strictEqual(JSON.stringify(Array.from(s.listReferrers('', '成約').map(r => r.ID))), JSON.stringify(['R0002']));
assert.strictEqual(JSON.stringify(Array.from(s.listReferrers('佐々木', '成約').map(r => r.ID))), JSON.stringify([]));

// ステータス変更 / 更新
s.updateStatus('R0001', '対応中');
assert.strictEqual(s.listReferrers('R0001', '')[0].ステータス, '対応中');
const updated = s.updateReferrer('R0003', { '電話番号': '080-0000-0000', 'ID': 'RXXXX' });
assert.strictEqual(updated.電話番号, '080-0000-0000');
assert.strictEqual(updated.ID, 'R0003', 'ID は書き換えられない');
assert.throws(() => s.updateReferrer('R0001', { '紹介者名': '' }), /紹介者名は必須/);
assert.throws(() => s.updateStatus('R9999', '成約'), /見つかりません/);

// 集計
const summary = s.getSummary();
assert.strictEqual(summary.total, 3);
assert.strictEqual(summary.byStatus['成約'], 1);
assert.strictEqual(summary.byStatus['対応中'], 1);
assert.strictEqual(summary.byReferrer[0].紹介者名, '山田 太郎');
assert.strictEqual(summary.byReferrer[0].件数, 2);
assert.strictEqual(summary.byReferrer[0].成約, 1);

// 削除と ID の連番
s.deleteReferrer('R0002');
assert.strictEqual(JSON.stringify(Array.from(s.listReferrers('', '').map(r => r.ID))), JSON.stringify(['R0003', 'R0001']));
assert.strictEqual(s.addReferrer({ '紹介者名': '新規 次郎' }).ID, 'R0004', '削除後も ID は重複しない');
assert.throws(() => s.deleteReferrer('R0002'), /見つかりません/);

console.log('全テスト通過:', s.listReferrers('', '').length, '件');

/* ---------------------------------------------------------------------------
 * 外部連携（Api.gs の doPost）
 * ------------------------------------------------------------------------ */
const post = (payload) => JSON.parse(s.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());

// 合言葉が未発行のうちは誰も通さない
assert.strictEqual(post({ action: 'bootstrap' }).ok, false);
assert.match(post({ action: 'bootstrap' }).error, /未発行/);

const token = s.issueApiToken();
assert.strictEqual(typeof token, 'string');
assert.strictEqual(post({ action: 'bootstrap', token: 'wrong' }).ok, false);
assert.match(post({ action: 'bootstrap', token: 'wrong' }).error, /合言葉が違います/);

// 正しい合言葉なら、画面が必要とする3点セットが返る
const boot = post({ action: 'bootstrap', token: token });
assert.strictEqual(boot.ok, true);
assert.strictEqual(boot.data.config.spreadsheetName, '紹介者管理テスト', '接続先のスプレッドシート名を返す');
assert.strictEqual(JSON.stringify(boot.data.config.statuses), JSON.stringify(['未対応', '対応中', '成約', '見送り']));
assert.strictEqual(boot.data.list.length, s.listReferrers('', '').length);
assert.strictEqual(boot.data.summary.total, boot.data.list.length);

// 登録・ステータス変更・削除も API 経由で通る
const created = post({ action: 'add', token: token, form: { '紹介者名': 'API 経由' } });
assert.strictEqual(created.ok, true);
assert.strictEqual(created.data.紹介者名, 'API 経由');
assert.strictEqual(post({ action: 'updateStatus', token: token, id: created.data.ID, status: '成約' }).data.ステータス, '成約');
assert.strictEqual(post({ action: 'delete', token: token, id: created.data.ID }).ok, true);
assert.strictEqual(post({ action: 'なにこれ', token: token }).ok, false);

// 空リクエストや壊れた JSON でも落ちない
assert.strictEqual(JSON.parse(s.doPost({}).getContent()).ok, false);
assert.strictEqual(JSON.parse(s.doPost({ postData: { contents: '{' } }).getContent()).ok, false);

// 接続状況の表示に、書き込み先が出る
const connection = s.showConnection();
assert.match(connection, /紹介者管理テスト/);
assert.match(connection, /発行済み/);

console.log('外部連携（doPost）も通過');
