import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

const base = 'http://127.0.0.1:5175/pages';
const pages = [
  { id: 'dashboard', name: '01-dashboard.png', label: '开始处理' },
  { id: 'inbox',     name: '02-inbox.png',     label: '邮件记录' },
  { id: 'library',   name: '03-library.png',   label: '发票库' },
  { id: 'pending',   name: '04-pending.png',   label: '待确认' },
  { id: 'config',    name: '05-config.png',    label: '邮箱与保存' },
  { id: 'settings',  name: '06-settings.png',  label: '关于' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  locale: 'zh-CN',
});
const page = await ctx.newPage();

for (const p of pages) {
  const url = `${base}/${p.id}.html`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const target = path.join(outDir, p.name);
  await page.screenshot({ path: target, fullPage: false });
  console.log(`saved ${p.label} -> ${path.relative(root, target)}`);
}

await ctx.close();
await browser.close();
