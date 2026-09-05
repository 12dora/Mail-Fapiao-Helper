/**
 * 界面截图：脚本自带静态服务器托管 gui-design/，用 `?fake=1` 打开内存数据。
 * 需要先跑 `npm run build:renderer`（或 `npm run build`）产出 gui-design/dist。
 *
 *   node scripts/take-screenshots.mjs [--out <dir>]
 */
import { chromium } from 'playwright';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// antd 的类名统一收在测试帮手里，升级 antd 时只改那一个文件。
import { openRow } from '../gui-design/tests/ui-helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(root, 'gui-design');
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outDir =
  outIndex >= 0 && argv[outIndex + 1] ? path.resolve(argv[outIndex + 1]) : path.join(root, 'docs', 'screenshots');

if (!existsSync(path.join(uiRoot, 'dist', 'app.js'))) {
  console.error('缺少 gui-design/dist/app.js，请先运行 npm run build:renderer');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const target = path.resolve(uiRoot, rel);
  if (!target.startsWith(uiRoot) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/index.html?fake=1`;

/**
 * 五个路由各一张，外加一张详情抽屉——抽屉是这版界面的主要交互，
 * 只截列表页会让 README 看不出点开一行会发生什么。
 */
const routes = [
  { hash: '#/dashboard', name: '01-dashboard.png', label: '开始处理' },
  { hash: '#/inbox', name: '02-inbox.png', label: '邮件记录' },
  { hash: '#/library', name: '03-library.png', label: '发票库' },
  { hash: '#/pending', name: '04-pending.png', label: '待确认' },
  { hash: '#/settings', name: '05-settings.png', label: '设置' },
  { hash: '#/library', name: '06-invoice-drawer.png', label: '发票详情', openRow: true },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  locale: 'zh-CN',
});
const page = await ctx.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error(`[renderer] ${msg.text()}`);
});

for (const route of routes) {
  await page.goto(`${base}${route.hash}`, { waitUntil: 'networkidle' });
  // 等外壳渲染出来再截，避免拍到空白首帧。
  await page.waitForSelector('.mfh-sider', { state: 'visible' });
  await page.waitForTimeout(600);
  if (route.openRow) {
    await openRow(page, 'table-library', 0);
    await page.waitForSelector('[data-testid="drawer-invoice"]', { state: 'visible' });
    await page.waitForTimeout(600);
  }
  const target = path.join(outDir, route.name);
  await page.screenshot({ path: target, fullPage: false });
  console.log(`saved ${route.label} -> ${path.relative(root, target)}`);
}

await ctx.close();
await browser.close();
server.close();
