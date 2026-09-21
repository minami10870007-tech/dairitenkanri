/**
 * Netlify のページ ↔ GAS ウェブアプリ間の通信を、GAS と同じ振る舞いのモックで検証する。
 *
 * ・CORS プリフライト（OPTIONS）が飛ばないこと＝text/plain で送れていること
 * ・リクエスト本文が Api.gs の期待する形（action / token / form）であること
 * ・一覧・登録・ステータス変更・削除・エラー表示が実際に動くこと
 *
 *   node tools/api-contract-test.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'testtoken123456';
const requests = [];
let rows = [
  { ID: 'R0001', 登録日: '2026/09/01 10:00', 紹介者名: '既存 太郎', 電話番号: '090-0000-0000', メール: 'a@example.com', 被紹介者: '株式会社既存', ステータス: '未対応', 備考: '', 更新日: '2026/09/01 10:00' },
];

/* GAS の doPost と同じ入出力を返すモック */
const api = http.createServer((req, res) => {
  requests.push({ method: req.method, contentType: req.headers['content-type'] || '' });
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method !== 'POST') { res.writeHead(405, cors).end(JSON.stringify({ ok: false, error: 'POST only' })); return; }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let request;
    try { request = JSON.parse(body); } catch { res.writeHead(200, cors).end(JSON.stringify({ ok: false, error: 'bad json' })); return; }
    if (request.token !== TOKEN) { res.writeHead(200, cors).end(JSON.stringify({ ok: false, error: '合言葉が違います。' })); return; }

    const reply = (data) => res.writeHead(200, cors).end(JSON.stringify({ ok: true, data }));
    const statuses = ['未対応', '対応中', '成約', '見送り'];
    switch (request.action) {
      case 'bootstrap': return reply({ config: { statuses }, list: rows.slice().reverse() });
      case 'config': return reply({ statuses });
      case 'add': {
        const id = 'R' + ('0000' + (rows.length + 1)).slice(-4);
        const row = { ID: id, 登録日: '2026/09/21 12:00', 更新日: '2026/09/21 12:00', 紹介者名: request.form.紹介者名, 電話番号: request.form.電話番号 || '', メール: request.form.メール || '', 被紹介者: request.form.被紹介者 || '', ステータス: request.form.ステータス || '未対応', 備考: request.form.備考 || '' };
        rows.push(row);
        return reply(row);
      }
      case 'updateStatus': {
        const row = rows.find((r) => r.ID === request.id);
        if (!row) return res.writeHead(200, cors).end(JSON.stringify({ ok: false, error: 'not found' }));
        row.ステータス = request.status;
        return reply(row);
      }
      case 'delete':
        rows = rows.filter((r) => r.ID !== request.id);
        return reply({ deleted: request.id });
      default:
        return res.writeHead(200, cors).end(JSON.stringify({ ok: false, error: '不明な action です: ' + request.action }));
    }
  });
});

/* ページ配信（API とは別オリジンにして、本番と同じクロスオリジン状況を作る） */
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(ROOT, 'netlify', 'index.html')).pipe(res);
});

await new Promise((r) => api.listen(0, '127.0.0.1', r));
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${api.address().port}/exec`;
const siteUrl = `http://localhost:${site.address().port}/`;

const chromeDir = fs.readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).sort().pop();
const browser = await chromium.launch({ executablePath: path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers', chromeDir, 'chrome-linux', 'chrome'), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const failures = [];
const check = (label, condition, detail) => {
  if (condition) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label + (detail ? ' … ' + detail : '')); failures.push(label); }
};

await context.addInitScript(([url, token]) => {
  localStorage.setItem('refmgr.apiUrl', url);
  localStorage.setItem('refmgr.token', token);
}, [apiUrl, TOKEN]);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(siteUrl);
await page.waitForTimeout(700);

console.log('通信の形');
check('OPTIONS（CORS プリフライト）が発生していない', requests.every((r) => r.method !== 'OPTIONS'), JSON.stringify(requests.map((r) => r.method)));
check('Content-Type が text/plain', requests.every((r) => r.method !== 'POST' || r.contentType.startsWith('text/plain')), requests.map((r) => r.contentType).join(','));

console.log('画面の動き');
check('保存済みの接続情報で自動的に一覧が出る', (await page.locator('.row-card__name').count()) === 1);
check('既存データの名前が出ている', (await page.locator('.row-card__name').first().innerText()) === '既存 太郎');

await page.click('#tab-form');
await page.fill('#f-name', '新規 花子');
await page.fill('#f-tel', '080-1111-2222');
await page.fill('#f-target', '株式会社テスト');
await page.click('#btn-save');
await page.waitForTimeout(500);
check('登録すると一覧に反映される', (await page.locator('.row-card__name').filter({ hasText: '新規 花子' }).count()) === 1);
check('サーバー側にも保存されている', rows.some((r) => r.紹介者名 === '新規 花子' && r.電話番号 === '080-1111-2222'), JSON.stringify(rows.map((r) => r.紹介者名)));
check('登録後にトーストが出る', (await page.locator('.toast').count()) >= 1);

const targetCard = page.locator('.row-card').filter({ hasText: '新規 花子' }).first();
await targetCard.locator('select').selectOption('成約');
await page.waitForTimeout(400);
check('ステータス変更がサーバーに届く', rows.find((r) => r.紹介者名 === '新規 花子')?.ステータス === '成約');
check('ステータスの色が変わる', (await targetCard.locator('select').getAttribute('class'))?.includes('is-won'));

await targetCard.locator('button[title="削除"]').click();
await page.waitForTimeout(250);
await page.click('#btn-delete-ok');
await page.waitForTimeout(450);
check('削除がサーバーに届く', !rows.some((r) => r.紹介者名 === '新規 花子'));
check('削除後に一覧から消える', (await page.locator('.row-card__name').filter({ hasText: '新規 花子' }).count()) === 0);

console.log('エラー処理');
await page.evaluate(() => localStorage.setItem('refmgr.token', 'wrong-token'));
await page.click('#btn-refresh');
await page.waitForTimeout(600);
const errorToast = await page.locator('.toast--err').count();
check('合言葉が違うとエラーが表示される', errorToast >= 1);
check('エラー文がそのまま画面に出る', (await page.locator('.toast--err').first().innerText()).includes('合言葉'));

await page.evaluate(() => localStorage.setItem('refmgr.apiUrl', 'http://127.0.0.1:1/exec'));
await page.evaluate(() => localStorage.setItem('refmgr.token', 'testtoken123456'));
await page.click('#btn-refresh');
await page.waitForTimeout(900);
check('接続できないときに案内が出る', (await page.locator('#list-empty .empty__title').innerText()).includes('読み込めませんでした'));

check('JS エラーが出ていない', errors.length === 0, errors.join(' / '));

await browser.close();
api.close();
site.close();

console.log(failures.length ? `\n${failures.length} 件失敗` : '\n✅ 通信まわりすべて通過');
process.exit(failures.length ? 1 : 0);
