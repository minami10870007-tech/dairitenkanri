/**
 * netlify/index.html の UI 自動監査。
 *
 * 実ブラウザ（Chromium）で「端末幅 × ライト/ダーク × 各画面」を開き、
 * レスポンシブ崩れ・タップ領域・文字サイズ・コントラスト・アクセシビリティを機械チェックする。
 *
 *   npm run audit            … 全チェック
 *   npm run audit -- --shots … スクリーンショットも保存（audit-out/）
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'netlify');
const OUT_DIR = path.join(ROOT, 'audit-out');
const WANT_SHOTS = process.argv.includes('--shots');

const VIEWPORTS = [
  { name: '320x568-se', width: 320, height: 568, mobile: true },
  { name: '360x640-android', width: 360, height: 640, mobile: true },
  { name: '390x844-iphone14', width: 390, height: 844, mobile: true },
  { name: '430x932-iphonemax', width: 430, height: 932, mobile: true },
  { name: '768x1024-ipad', width: 768, height: 1024, mobile: false },
  { name: '1024x768-ipad-land', width: 1024, height: 768, mobile: false },
  { name: '1440x900-desktop', width: 1440, height: 900, mobile: false },
];
const THEMES = ['light', 'dark'];
const VIEWS = ['list', 'form', 'summary'];

/* ---------------------------------------------------------------- 静的サーバー */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dir = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().pop();
  const candidate = path.join(base, dir, 'chrome-linux', 'chrome');
  if (!fs.existsSync(candidate)) throw new Error('Chromium が見つかりません: ' + candidate);
  return candidate;
}

/* ---------------------------------------------------------------- ページ内チェック */
/** ブラウザ内で実行する監査本体。DOM を実測するのでここに閉じ込める。 */
const inPageAudit = () => {
  const issues = [];
  const add = (rule, message, selector) => issues.push({ rule, message, selector });

  const describe = (node) => {
    if (!node || node.nodeType !== 1) return String(node);
    let out = node.tagName.toLowerCase();
    if (node.id) out += '#' + node.id;
    else if (node.className && typeof node.className === 'string') out += '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.');
    const text = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (text) out += ' «' + text + '»';
    return out;
  };
  const isVisible = (node) => {
    if (node.nodeType !== 1) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  /** 読み上げ専用の視覚的非表示要素（clip で 1px に潰しているもの）は検査対象外 */
  const isVisuallyHidden = (node) => {
    if (node.classList.contains('sr-only')) return true;
    const style = getComputedStyle(node);
    if (style.clip === 'rect(0px, 0px, 0px, 0px)') return true;
    if (style.clipPath === 'inset(50%)') return true;
    const rect = node.getBoundingClientRect();
    return rect.width <= 1 && rect.height <= 1;
  };
  const visibleElements = [...document.querySelectorAll('body *')]
    .filter(isVisible)
    .filter((node) => !isVisuallyHidden(node));

  /* 1. 横スクロールが出ていないか */
  const docWidth = document.documentElement.scrollWidth;
  if (docWidth > window.innerWidth + 1) {
    add('no-horizontal-scroll', `ページ全体が横に ${docWidth - window.innerWidth}px はみ出しています（scrollWidth=${docWidth}, viewport=${window.innerWidth}）`, 'html');
  }

  /* 2. 個々の要素が画面幅を超えていないか（横スクロール前提の要素は除く） */
  const scrollableAncestor = (node) => {
    for (let p = node.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  for (const node of visibleElements) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) continue;
    const overflowRight = rect.right - window.innerWidth;
    if ((overflowRight > 1 || rect.left < -1) && !scrollableAncestor(node)) {
      add('element-in-viewport', `画面外にはみ出しています（left=${Math.round(rect.left)}, right=${Math.round(rect.right)}, viewport=${window.innerWidth}）`, describe(node));
    }
  }

  /* 3. 内容がコンテナから溢れていないか（overflow:hidden で切れていないか） */
  for (const node of visibleElements) {
    const style = getComputedStyle(node);
    if (style.overflowX !== 'hidden' && style.overflowY !== 'hidden') continue;
    if (node.scrollWidth > node.clientWidth + 1 && style.overflowX === 'hidden') {
      add('content-clipped', `内容が横にはみ出して切れています（scrollWidth=${node.scrollWidth} > clientWidth=${node.clientWidth}）`, describe(node));
    }
  }

  /* 4. タップ領域（44x44 以上。文章内リンクは対象外） */
  const TAP_MIN = 44;
  const interactive = visibleElements.filter((node) => {
    if (node.matches('button, select, [role="tab"], [role="button"]')) return true;
    if (node.matches('input, textarea')) return !node.matches('[type="hidden"]');
    return false;
  });
  for (const node of interactive) {
    const rect = node.getBoundingClientRect();
    if (rect.height < TAP_MIN - 0.5 || rect.width < 24) {
      add('tap-target', `タップ領域が小さいです（${Math.round(rect.width)}x${Math.round(rect.height)} < ${TAP_MIN}）`, describe(node));
    }
  }

  /* 5. 文字サイズ（本文 12px 以上 / 入力欄は iOS ズーム回避のため 16px 以上） */
  for (const node of visibleElements) {
    const hasOwnText = [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!hasOwnText) continue;
    const size = parseFloat(getComputedStyle(node).fontSize);
    if (size < 12) add('font-size', `文字が小さすぎます（${size}px < 12px）`, describe(node));
  }
  for (const node of visibleElements.filter((n) => n.matches('input, select, textarea'))) {
    const size = parseFloat(getComputedStyle(node).fontSize);
    if (size < 16) add('input-font-size', `入力欄の文字が 16px 未満で iOS が自動ズームします（${size}px）`, describe(node));
  }

  /* 6. コントラスト比（WCAG AA: 通常 4.5、大きい文字 3.0） */
  /**
   * 計算後の色文字列を RGBA にする。color-mix() は hover 時に oklab() / color(srgb ...) に
   * 解決されるため、正規表現ではなく canvas にブラウザ自身で解決させる。
   */
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  const parseColor = (value) => {
    if (!value || value === 'none') return null;
    if (colorCache.has(value)) return colorCache.get(value);
    let result = null;
    const direct = value.match(/^rgba?\(([^)]+)\)$/);
    if (direct) {
      const parts = direct[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      result = { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    } else {
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = value;
      if (colorCtx.fillStyle !== '#000' || /^(#000000|#000|black|rgb\(0, 0, 0\))$/i.test(value.trim())) {
        colorCtx.fillRect(0, 0, 1, 1);
        const data = colorCtx.getImageData(0, 0, 1, 1).data;
        result = { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
      }
    }
    colorCache.set(value, result);
    return result;
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /** 背景色の候補を返す。グラデーションは色停止点すべてを候補に入れて最悪値で判定する */
  const effectiveBgs = (node) => {
    let acc = null;
    for (let p = node; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      const image = style.backgroundImage;
      if (image && image !== 'none') {
        const stops = [...image.matchAll(/(?:rgba?|oklab|oklch|lab|lch|color|hsla?)\([^()]*(?:\([^()]*\))?[^()]*\)/g)]
          .map((m) => parseColor(m[0])).filter(Boolean);
        if (!stops.length) return { unknown: true };
        const under = acc;
        return { list: stops.map((stop) => (stop.a < 1 && under ? over(stop, under) : stop)) };
      }
      const color = parseColor(style.backgroundColor);
      if (!color || color.a === 0) continue;
      acc = acc ? over(acc, color) : color;
      if (acc.a >= 1 || color.a >= 1) return { list: [acc] };
    }
    return { list: [acc || { r: 255, g: 255, b: 255, a: 1 }] };
  };
  const skippedContrast = [];
  for (const node of visibleElements) {
    const hasOwnText = [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!hasOwnText) continue;
    const style = getComputedStyle(node);
    const fg = parseColor(style.color);
    if (!fg) continue;
    const bgs = effectiveBgs(node);
    if (bgs.unknown) { skippedContrast.push(describe(node)); continue; }
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    for (const bg of bgs.list) {
      const composited = fg.a < 1 ? over(fg, bg) : fg;
      const got = ratio(composited, bg);
      if (got < need) {
        add('contrast', `コントラスト比 ${got.toFixed(2)} が基準 ${need} 未満です（文字 ${style.color} / 背景 rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}), ${size}px）`, describe(node));
        break;
      }
    }
  }

  /* 7. アクセシビリティの基本 */
  const accName = (node) => {
    const aria = node.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledby = node.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (text) return text;
    }
    if (node.id) {
      const label = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (label && label.textContent.trim()) return label.textContent.trim();
    }
    if (node.closest('label') && node.closest('label').textContent.trim()) return node.closest('label').textContent.trim();
    if (node.matches('button, a, [role="tab"], [role="button"]')) {
      const text = node.textContent.trim();
      if (text) return text;
      const title = node.getAttribute('title');
      if (title) return title.trim();
    }
    const title = node.getAttribute('title');
    return title ? title.trim() : '';
  };
  for (const node of visibleElements.filter((n) => n.matches('input, select, textarea, button, [role="tab"], a[href]'))) {
    if (!accName(node)) add('accessible-name', '名前（ラベル）がないため読み上げできません', describe(node));
  }
  for (const node of visibleElements.filter((n) => n.matches('img'))) {
    if (!n0Alt(node)) add('img-alt', 'alt 属性がありません', describe(node));
  }
  function n0Alt(node) { return node.hasAttribute('alt'); }

  const visibleH1 = visibleElements.filter((n) => n.matches('h1'));
  if (visibleH1.length === 0) add('heading', '見えている h1 見出しがありません', 'body');
  if (visibleH1.length > 1) add('heading', `見えている h1 が ${visibleH1.length} 個あります`, visibleH1.map(describe).join(' / '));

  /* 8. スマホでは表ではなくカードで出す（表の横スクロール依存を避ける） */
  const tableWrap = document.getElementById('table-wrap');
  const cards = document.getElementById('list-cards');
  if (tableWrap && cards && !tableWrap.hidden) {
    const tableVisible = isVisible(tableWrap);
    const cardsVisible = isVisible(cards);
    const TABLE_FROM = 880; // netlify/index.html のブレークポイントと合わせる
    if (window.innerWidth < TABLE_FROM && tableVisible) add('mobile-layout', '狭い画面で表が表示されています（カード表示にすべき）', '#table-wrap');
    if (window.innerWidth >= TABLE_FROM && cardsVisible) add('mobile-layout', '広い画面でカードが表示されています（表にすべき）', '#list-cards');
    if (tableVisible && cardsVisible) add('mobile-layout', '表とカードが同時に表示されています', '#table-wrap + #list-cards');
  }

  /* 8.5 固定バーが画面下端にあるか（ancestor の filter/backdrop-filter で位置がずれる事故の検出） */
  const fixedBar = document.querySelector('.tabs');
  if (fixedBar && getComputedStyle(fixedBar).position === 'fixed') {
    const rect = fixedBar.getBoundingClientRect();
    if (Math.abs(rect.bottom - window.innerHeight) > 2) {
      add('fixed-position', `固定タブバーが画面下端にありません（bottom=${Math.round(rect.bottom)}, 画面高=${window.innerHeight}）。祖先の filter / backdrop-filter / transform が包含ブロックになっている可能性があります`, '.tabs');
    }
    const header = document.querySelector('.app-header');
    if (header && rect.top < header.getBoundingClientRect().bottom) {
      add('fixed-position', '固定タブバーがヘッダーに重なっています', '.tabs');
    }
  }

  /* 9. 固定要素が内容を覆っていないか（下部タブバーと最終要素の重なり） */
  const tabs = document.querySelector('.tabs');
  if (tabs && getComputedStyle(tabs).position === 'fixed') {
    const bar = tabs.getBoundingClientRect();
    const main = document.querySelector('.main');
    const docBottom = document.documentElement.scrollHeight;
    const scrolledToBottom = window.scrollY + window.innerHeight >= docBottom - 2;
    if (scrolledToBottom && main) {
      // main の padding-bottom はバーを避けるための余白なので、中身の末尾で判定する
      let contentBottom = -Infinity;
      let lowest = null;
      for (const node of main.querySelectorAll('*')) {
        if (!isVisible(node) || isVisuallyHidden(node)) continue;
        if (node.children.length && !([...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))) continue;
        const rect = node.getBoundingClientRect();
        if (rect.bottom > contentBottom) { contentBottom = rect.bottom; lowest = node; }
      }
      if (lowest && contentBottom > bar.top + 1) {
        add('fixed-overlap', `下部タブバーが本文の末尾（${describe(lowest)}）に重なっています（末尾=${Math.round(contentBottom)}, バー上端=${Math.round(bar.top)}）`, '.tabs');
      }
    }
  }

  return { issues, skippedContrast: [...new Set(skippedContrast)] };
};

/* ---------------------------------------------------------------- 実行 */
const server = await serve();
const baseUrl = `http://127.0.0.1:${server.address().port}/index.html?demo=1`;
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });

if (WANT_SHOTS) fs.rmSync(OUT_DIR, { recursive: true, force: true });
if (WANT_SHOTS) fs.mkdirSync(OUT_DIR, { recursive: true });

const findings = [];
const consoleErrors = [];
const skipped = new Set();

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      colorScheme: theme,
      hasTouch: viewport.mobile,
      isMobile: viewport.mobile,
      locale: 'ja-JP',
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`${viewport.name}/${theme}: ${message.text()}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`${viewport.name}/${theme}: ${error.message}`));

    try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('list-skeleton') || document.getElementById('list-skeleton').hidden);
    await page.waitForTimeout(120);

    for (const view of VIEWS) {
      await page.click(`#tab-${view}`);
      await page.waitForTimeout(140);

      const result = await page.evaluate(inPageAudit);
      result.skippedContrast.forEach((s) => skipped.add(s));
      result.issues.forEach((issue) => findings.push({ ...issue, where: `${viewport.name}/${theme}/${view}` }));

      // 末尾までスクロールした状態も見る（固定バーの被り確認）
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(100);
      const bottom = await page.evaluate(inPageAudit);
      bottom.issues
        .filter((i) => i.rule === 'fixed-overlap' || i.rule === 'element-in-viewport')
        .forEach((issue) => findings.push({ ...issue, where: `${viewport.name}/${theme}/${view}(最下部)` }));
      await page.evaluate(() => window.scrollTo(0, 0));

      if (WANT_SHOTS && theme === 'light') {
        await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-${view}.png`), fullPage: true });
      }
      if (WANT_SHOTS && theme === 'dark' && view === 'list') {
        await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-dark-list.png`), fullPage: true });
      }
    }

    // ダイアログ（削除確認）も監査する
    await page.click('#tab-list');
    await page.waitForTimeout(100);
    const deleteButton = page.locator('button[title="削除"]:visible').first();
    if (await deleteButton.count()) {
      await deleteButton.click();
      await page.waitForTimeout(220);
      const dialogResult = await page.evaluate(inPageAudit);
      dialogResult.issues
        .filter((i) => i.rule !== 'heading')
        .forEach((issue) => findings.push({ ...issue, where: `${viewport.name}/${theme}/削除ダイアログ` }));
      if (WANT_SHOTS && theme === 'light' && viewport.mobile) {
        await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-dialog.png`) });
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }

    // 接続設定ダイアログ
    await page.click('#btn-settings');
    await page.waitForTimeout(220);
    const settingsResult = await page.evaluate(inPageAudit);
    settingsResult.issues
      .filter((i) => i.rule !== 'heading')
      .forEach((issue) => findings.push({ ...issue, where: `${viewport.name}/${theme}/接続設定` }));
    if (WANT_SHOTS && theme === 'light' && viewport.name === '390x844-iphone14') {
      await page.screenshot({ path: path.join(OUT_DIR, `settings-dialog.png`) });
    }
    await page.keyboard.press('Escape');

    // 登録フローが動くか（デモデータに1件足す）
    await page.click('#tab-form');
    await page.fill('#f-name', '監査 テスト');
    await page.fill('#f-target', '株式会社チェック');
    await page.click('#btn-save');
    await page.waitForTimeout(520);
    const added = await page.locator('#list-cards .row-card__name, #table-body .cell-name').filter({ hasText: '監査 テスト' }).count();
    if (!added) findings.push({ rule: 'flow', message: '登録しても一覧に出てきません', selector: '#form', where: `${viewport.name}/${theme}` });
    const toastVisible = await page.locator('.toast').count();
    if (!toastVisible) findings.push({ rule: 'flow', message: '登録後のトーストが出ません', selector: '.toasts', where: `${viewport.name}/${theme}` });

    } catch (error) {
      findings.push({ rule: 'operation-failed', message: String(error.message || error).split('\n')[0], selector: '-', where: `${viewport.name}/${theme}` });
    }
    await context.close();
  }
}

await browser.close();
server.close();

/* ---------------------------------------------------------------- 結果出力 */
const grouped = new Map();
for (const finding of findings) {
  const key = `${finding.rule}|${finding.message}|${finding.selector}`;
  if (!grouped.has(key)) grouped.set(key, { ...finding, where: [finding.where] });
  else grouped.get(key).where.push(finding.where);
}

const unique = [...grouped.values()];
console.log('='.repeat(72));
console.log(`検査: ${VIEWPORTS.length} 画面幅 × ${THEMES.length} テーマ × ${VIEWS.length} タブ + ダイアログ + 登録フロー`);
console.log('='.repeat(72));

if (!unique.length && !consoleErrors.length) {
  console.log('✅ 指摘なし（横スクロール / はみ出し / タップ領域 / 文字サイズ / コントラスト / ラベル / レイアウト切替 / 固定バー / 登録フロー）');
} else {
  const byRule = new Map();
  for (const item of unique) byRule.set(item.rule, (byRule.get(item.rule) || []).concat(item));
  for (const [rule, items] of byRule) {
    console.log(`\n▼ ${rule} (${items.length})`);
    for (const item of items) {
      const where = item.where.length > 3 ? `${item.where.slice(0, 3).join(', ')} 他${item.where.length - 3}件` : item.where.join(', ');
      console.log(`  - ${item.message}\n    要素: ${item.selector}\n    場所: ${where}`);
    }
  }
  if (consoleErrors.length) {
    console.log(`\n▼ console-error (${consoleErrors.length})`);
    [...new Set(consoleErrors)].forEach((e) => console.log('  - ' + e));
  }
}
if (skipped.size) {
  console.log(`\nℹ コントラスト自動判定をスキップ（背景がグラデーション）: ${skipped.size} 件 → 目視確認対象`);
  [...skipped].slice(0, 10).forEach((s) => console.log('   ・' + s));
}
console.log(`\n合計 ${unique.length} 種類の指摘 / console エラー ${new Set(consoleErrors).size} 件`);
if (WANT_SHOTS) console.log(`スクリーンショット: ${path.relative(ROOT, OUT_DIR)}/`);

process.exit(unique.length || consoleErrors.length ? 1 : 0);
