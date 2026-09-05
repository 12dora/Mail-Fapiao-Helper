/* Shared helpers for the browser-side renderer suites.
 *
 * The renderer is a single React + antd page (gui-design/index.html) with hash
 * routes, so every selector here is either a `data-testid` the renderer owns
 * (see gui-design/src/README.md) or an antd class that has no stable
 * alternative (pagination, segmented chips, drawers, toasts). Keeping the
 * antd-shaped selectors in one file means an antd upgrade breaks one place.
 */

import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { NO_GUI_E2E_ENV, closeElectronApp, electronTestEnv, fail, repoRoot } from './_shared.mjs';

export const uiRoot = fileURLToPath(new URL('..', import.meta.url));

export const ROUTES = [
  { key: 'dashboard', title: '开始处理' },
  { key: 'inbox', title: '邮件记录' },
  { key: 'library', title: '发票库' },
  { key: 'pending', title: '待确认' },
  { key: 'settings', title: '设置' },
];

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

/** Static server rooted at gui-design/ — the same layout Electron loads from disk. */
export function startStaticServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const fullPath = normalize(join(uiRoot, requested));
    if (!fullPath.startsWith(uiRoot)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(fullPath);
      res.writeHead(200, { 'content-type': MIME.get(extname(fullPath)) || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export function appUrl(baseUrl, { variant = '1', route = 'dashboard' } = {}) {
  return `${baseUrl}/index.html?fake=${variant}#/${route}`;
}

/* ---------------------------------------------------------------------------
 * Page bring-up + diagnostics
 * ------------------------------------------------------------------------ */

/**
 * Collects every console error, uncaught exception and CSP violation for the
 * lifetime of the page. A renderer that logs an error is a failing renderer:
 * the suites assert this list is empty at the end of each flow.
 */
export function watchPage(page) {
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  return problems;
}

/** `securitypolicyviolation` only fires in the page, so the probe has to live there. */
export async function installCspProbe(page) {
  await page.addInitScript(() => {
    window.__mfhCsp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__mfhCsp.push(`${event.violatedDirective} <- ${event.blockedURI}`);
    });
  });
}

export async function cspViolations(page) {
  return page.evaluate(() => window.__mfhCsp ?? []);
}

/**
 * Records transient UI that a poll would miss.
 *
 * Against the fake CLI a whole run can finish inside one polling interval, so
 * "did the run banner appear?" and "which toast did it raise?" cannot be
 * answered by waiting — a MutationObserver in the page has to remember them.
 */
export async function installUiProbe(page) {
  await page.addInitScript(() => {
    window.__mfhUi = { banner: false, toasts: [] };
    const sample = () => {
      if (document.querySelector('[data-testid="op-banner"]')) window.__mfhUi.banner = true;
      for (const el of document.querySelectorAll('.ant-message-notice-content, .ant-notification-notice')) {
        const text = el.innerText.replace(/\s+/g, ' ').trim();
        if (text && !window.__mfhUi.toasts.includes(text)) window.__mfhUi.toasts.push(text);
      }
    };
    const start = () => {
      new MutationObserver(sample).observe(document.body, { childList: true, subtree: true, characterData: true });
      sample();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  });
}

export async function readUiProbe(page) {
  return page.evaluate(() => window.__mfhUi ?? { banner: false, toasts: [] });
}

export async function resetUiProbe(page) {
  await page.evaluate(() => {
    if (window.__mfhUi) {
      window.__mfhUi.banner = false;
      window.__mfhUi.toasts = [];
    }
  });
}

/** Opens the app and waits until the shell (sider + a page title) is on screen. */
export async function openApp(page, baseUrl, options = {}) {
  await page.goto(appUrl(baseUrl, options), { waitUntil: 'domcontentloaded' });
  await page.locator('.mfh-sider').waitFor({ state: 'visible', timeout: 15000 });
  await tid(page, 'page-title').waitFor({ state: 'visible', timeout: 15000 });
  return page;
}

/* ---------------------------------------------------------------------------
 * Selectors
 * ------------------------------------------------------------------------ */

export function tid(page, name) {
  return page.locator(`[data-testid="${name}"]`);
}

export async function pageTitle(page) {
  return (await tid(page, 'page-title').innerText()).trim();
}

/** Clicks a sidebar entry and waits for the route's own header title. */
export async function gotoRoute(page, key) {
  const route = ROUTES.find((item) => item.key === key);
  if (!route) fail(`未知路由：${key}`);
  await tid(page, `nav-${key}`).click();
  await page
    .waitForFunction(
      (expected) => document.querySelector('[data-testid="page-title"]')?.textContent?.trim() === expected,
      route.title,
      { timeout: 10000 },
    )
    .catch(() => fail(`切换到 ${key} 后标题不是「${route.title}」`));
  return route.title;
}

export function tableRows(page, table) {
  return page.locator(`[data-testid="${table}"] .ant-table-tbody > tr.ant-table-row`);
}

export async function rowCount(page, table) {
  return tableRows(page, table).count();
}

export async function waitForRows(page, table, predicate, label) {
  await page
    .waitForFunction(
      ({ sel }) => document.querySelectorAll(`[data-testid="${sel}"] .ant-table-tbody > tr.ant-table-row`).length,
      { sel: table },
      { timeout: 10000 },
    )
    .catch(() => fail(`${label ?? table} 一直没有渲染出数据行`));
  const count = await rowCount(page, table);
  if (!predicate(count)) fail(`${label ?? table} 的行数不符合预期，实际 ${count}`);
  return count;
}

/** Types into a table's search box and waits until the row count settles. */
export async function searchTable(page, table, text) {
  const before = await rowCount(page, table);
  await page.locator(`[data-testid="${table}-search"]`).fill(text);
  await page
    .waitForFunction(
      ({ sel, previous }) =>
        document.querySelectorAll(`[data-testid="${sel}"] .ant-table-tbody > tr.ant-table-row`).length !== previous,
      { sel: table, previous: before },
      { timeout: 8000 },
    )
    .catch(() => {
      /* Identical row counts are legitimate when the needle matches everything. */
    });
  return rowCount(page, table);
}

/**
 * Segmented chips render as antd labels; there is no per-option DOM hook.
 * Waits for the chip to actually read as selected rather than for a fixed
 * delay — the table re-renders on its own schedule.
 */
export async function clickChip(page, table, label) {
  const chip = page.locator(`[data-testid="${table}"] .ant-segmented-item-label`, { hasText: label });
  await chip.first().click();
  await page
    .waitForFunction(
      ({ sel, want }) =>
        document
          .querySelector(`[data-testid="${sel}"] .ant-segmented-item-selected .ant-segmented-item-label`)
          ?.textContent?.trim() === want,
      { sel: table, want: label },
      { timeout: 8000 },
    )
    .catch(() => fail(`${table} 的「${label}」筛选没有选中`));
}

export async function chipLabels(page, table) {
  return page.locator(`[data-testid="${table}"] .ant-segmented-item-label`).allInnerTexts();
}

/** antd pagination: page-size select + its dropdown options (rendered on <body>). */
async function openPageSizeMenu(page, table) {
  await page.locator(`[data-testid="${table}"] .ant-pagination-options .ant-select-selector`).click();
  await page.locator('.ant-select-item-option-content').first().waitFor({ state: 'visible', timeout: 8000 });
}

export async function pageSizeOptions(page, table) {
  await openPageSizeMenu(page, table);
  const options = await page.locator('.ant-select-item-option-content').allInnerTexts();
  await page.keyboard.press('Escape');
  return options.map((text) => text.trim());
}

export async function setPageSize(page, table, size) {
  await openPageSizeMenu(page, table);
  await page.locator('.ant-select-item-option-content', { hasText: `${size} 条/页` }).first().click();
  await page
    .waitForFunction(
      ({ sel, want }) =>
        document
          .querySelector(`[data-testid="${sel}"] .ant-pagination-options .ant-select-selection-item`)
          ?.textContent?.trim() === want,
      { sel: table, want: `${size} 条/页` },
      { timeout: 8000 },
    )
    .catch(() => fail(`${table} 没有切到每页 ${size} 条`));
}

/** antd 分页的页码按钮与当前页；没有 data-testid 可用。 */
export async function gotoPage(page, table, index) {
  await page.locator(`[data-testid="${table}"] .ant-pagination-item-${index}`).first().click();
  await page
    .waitForFunction(
      ({ sel, want }) =>
        document.querySelector(`[data-testid="${sel}"] .ant-pagination-item-active`)?.textContent?.trim()
        === String(want),
      { sel: table, want: index },
      { timeout: 8000 },
    )
    .catch(() => fail(`${table} 没有翻到第 ${index} 页`));
}

export async function currentPage(page, table) {
  const active = page.locator(`[data-testid="${table}"] .ant-pagination-item-active`).first();
  if ((await active.count()) === 0) return 1;
  return Number((await active.innerText()).trim());
}

export async function openRow(page, table, index = 0) {
  await tableRows(page, table).nth(index).click();
}

export async function closeDrawer(page) {
  await page.locator('.ant-drawer-close').first().click();
  await page.locator('.ant-drawer-content').first().waitFor({ state: 'hidden', timeout: 8000 });
}

/** Toast text: antd message (title only) and notification (title + detail). */
export async function waitForToast(page, text, timeout = 15000) {
  await page
    .locator('.ant-message-notice-content, .ant-notification-notice')
    .filter({ hasText: text })
    .first()
    .waitFor({ state: 'visible', timeout })
    .catch(() => fail(`没有等到提示：${text}`));
}

export async function dismissToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.ant-notification-notice-close').forEach((btn) => btn.click());
    document.querySelectorAll('.ant-message-notice, .ant-notification-notice').forEach((el) => el.remove());
  });
}

/** antd Modal body; dedupe is the only modal in the app. */
export async function waitForModalClosed(page, timeout = 15000) {
  await page.locator('.ant-modal-content').first().waitFor({ state: 'hidden', timeout });
}

/** The filled part of an antd Progress; its width is the only readable percent. */
export async function progressWidth(page) {
  return page.locator('.ant-progress-bg').first().getAttribute('style');
}

/**
 * One row of an antd Descriptions list, by its label.
 *
 * Asserting on the whole drawer text lets an unrelated cell satisfy a check for
 * a specific field — an em dash anywhere would "prove" the engine was
 * translated. Returns null when the label is not there at all.
 */
export async function descriptionValue(page, testid, label) {
  return page.evaluate(
    ({ sel, want }) => {
      const root = document.querySelector(`[data-testid="${sel}"]`);
      for (const item of root?.querySelectorAll('.ant-descriptions-item') ?? []) {
        if (item.querySelector('.ant-descriptions-item-label')?.textContent?.trim() === want) {
          return item.querySelector('.ant-descriptions-item-content')?.textContent?.trim() ?? '';
        }
      }
      return null;
    },
    { sel: testid, want: label },
  );
}

/** Waits until the UI probe has seen at least one toast (they can auto-dismiss). */
export async function waitForProbeToast(page, timeout = 15000) {
  await page
    .waitForFunction(() => (window.__mfhUi?.toasts?.length ?? 0) > 0, undefined, { timeout })
    .catch(() => fail('没有等到任何提示'));
}

/**
 * The last call the preview bridge recorded for a channel.
 *
 * `?fake=…` has no system save dialog, so "did export actually happen?" can
 * only be answered by what the renderer handed the bridge.
 */
export async function waitForPreviewCall(page, name, timeout = 15000) {
  await page
    .waitForFunction((key) => Boolean(window.__mfhPreviewCalls?.[key]), name, { timeout })
    .catch(() => fail(`预览桥接没有收到 ${name} 调用`));
  return page.evaluate((key) => window.__mfhPreviewCalls[key], name);
}

export async function forgetPreviewCalls(page) {
  await page.evaluate(() => {
    window.__mfhPreviewCalls = {};
  });
}

/**
 * Proves the CSP is doing something: asserting "zero violations" also passes on
 * a page with no CSP at all. Injects the two things the policy must refuse and
 * reports what the page observed.
 */
export async function probeCspEnforcement(page, remoteUrl) {
  return page.evaluate(async (url) => {
    const seen = [];
    const onViolation = (event) => seen.push(`${event.violatedDirective} <- ${event.blockedURI}`);
    document.addEventListener('securitypolicyviolation', onViolation);
    try {
      window.__mfhInlineScriptRan = false;
      const script = document.createElement('script');
      script.textContent = 'window.__mfhInlineScriptRan = true;';
      document.body.appendChild(script);
      script.remove();

      const image = document.createElement('img');
      const loaded = await new Promise((resolve) => {
        image.addEventListener('load', () => resolve(true));
        image.addEventListener('error', () => resolve(false));
        image.src = url;
        document.body.appendChild(image);
        setTimeout(() => resolve(false), 3000);
      });
      image.remove();
      // Let the violation events land before reading them back.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { inlineRan: window.__mfhInlineScriptRan === true, imageLoaded: loaded, violations: seen };
    } finally {
      document.removeEventListener('securitypolicyviolation', onViolation);
    }
  }, remoteUrl);
}

export async function elementHeight(page, testid) {
  const box = await tid(page, testid).boundingBox();
  if (!box) fail(`拿不到 ${testid} 的尺寸`);
  return box.height;
}

export async function expectVisibleText(page, needle, scope = '.mfh-shell') {
  const found = await page.evaluate(
    ({ sel, text }) => Boolean(document.querySelector(sel)?.innerText.includes(text)),
    { sel: scope, text: needle },
  );
  if (!found) fail(`当前界面缺少文字：${needle}`);
}

export async function expectNoVisibleText(page, needle, scope = '.mfh-shell') {
  const found = await page.evaluate(
    ({ sel, text }) => Boolean(document.querySelector(sel)?.innerText.includes(text)),
    { sel: scope, text: needle },
  );
  if (found) fail(`当前界面不应出现文字：${needle}`);
}

export async function expectNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  if (overflow) fail(`${label} 存在横向溢出`);
}

/* ---------------------------------------------------------------------------
 * Copy lint
 *
 * The renderer's copy rules live in gui-design/src/README.md. These are the
 * ones a machine can check: no shouting, no filler, and no internal identifier
 * (IPC channel, machine reason code, bookkeeping CSV name) in user-facing text.
 * ------------------------------------------------------------------------ */

export const COPY_RULES = [
  { name: '感叹号', re: /[!！]/ },
  { name: '「请注意」', re: /请注意/ },
  { name: 'IPC 通道名', re: /mfh:[a-z-]+/i },
  { name: '内部前缀', re: /\b(ext|ipc|chan|evt):/i },
  { name: '台账 CSV 文件名', re: /\b(INDEX|ocr-pending|ocr-results|pending|invoices)\.csv\b/i },
  { name: '机器状态码', re: /\b(link_expired|http_403|manual_download_only|network_error|preview_only|ocr_no_work|same_invoice_no|amount_mismatch|settlement)\b/ },
  { name: 'JS 空值', re: /\b(undefined|NaN)\b|\[object Object\]/ },
];

/** Visible copy of the whole shell plus any open drawer / modal / toast. */
export async function visibleCopy(page) {
  return page.evaluate(() => {
    const parts = [];
    for (const sel of ['.mfh-shell', '.ant-drawer-content', '.ant-modal-content', '.ant-notification', '.ant-message']) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.innerText;
        if (text) parts.push(text);
      }
    }
    return parts.join('\n');
  });
}

export function lintCopy(text, where) {
  const hits = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const rule of COPY_RULES) {
      const match = rule.re.exec(trimmed);
      if (match) hits.push(`${where}：${rule.name} —— 「${trimmed.slice(0, 60)}」（命中 ${match[0]}）`);
    }
  }
  return hits;
}

export async function lintVisibleCopy(page, where) {
  return lintCopy(await visibleCopy(page), where);
}

/* ---------------------------------------------------------------------------
 * Electron bring-up
 *
 * Both Electron suites need the same thing: a throwaway data directory seeded
 * from config.example.json, and a launch that cannot leak the process tree.
 * Keeping it here means the smoke suite and the IPC fixture cannot drift into
 * testing two different config shapes.
 * ------------------------------------------------------------------------ */

/**
 * Seeds a temp data dir and returns the paths the launch needs.
 *
 * schema v3: `output` only carries `csv`; the directories come from `paths.*`.
 * Writing output.dir / output.pendingDir here would seed a dead field that the
 * migration silently drops.
 *
 * @param {(config: Record<string, unknown>) => void} [tweak] extra config edits
 */
export async function seedDataDir(tmp, tweak) {
  const configPath = join(tmp, 'config.json');
  await copyFile(join(repoRoot, 'config.example.json'), configPath);
  const config = JSON.parse(await readFile(configPath, 'utf8'));

  config.paths.samples = join(tmp, 'samples', 'raw');
  config.paths.invoices = join(tmp, 'invoices');
  config.paths.pending = join(tmp, 'pending');
  config.output.csv = join(tmp, 'invoices.csv');
  config.ocr.resultsCsv = join(tmp, 'invoices', 'ocr', 'ocr-results.csv');
  config.rename.organizedDir = join(tmp, 'invoices', 'organized');
  tweak?.(config);

  for (const dir of [config.paths.samples, config.paths.invoices, config.paths.pending]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { configPath, statePath: join(tmp, 'state.json'), userDataPath: join(tmp, 'user-data'), config };
}

export const ELECTRON_LAUNCH_TIMEOUT_MS = 60000;

/** Launches the app inside a cleanup scope; the process tree dies with the scope. */
export async function launchElectronApp(scope, { configPath, statePath, userDataPath, env = {} }) {
  const launchEnv = electronTestEnv({ MFH_CONFIG_PATH: configPath, MFH_STATE_PATH: statePath, ...env });
  if (launchEnv[NO_GUI_E2E_ENV] !== '1') fail('Electron 套件必须带 MFH_E2E_NO_GUI=1 启动');
  return scope.use(
    'Electron 应用',
    () =>
      electron.launch({
        cwd: repoRoot,
        args: ['.', `--user-data-dir=${userDataPath}`],
        timeout: ELECTRON_LAUNCH_TIMEOUT_MS,
        env: launchEnv,
      }),
    // app.close() only reaches the top process (and can wedge); the CLI/OCR
    // children it spawned must not survive an aborted suite either.
    (launched) => closeElectronApp(launched),
    { timeoutMs: ELECTRON_LAUNCH_TIMEOUT_MS + 10000 },
  );
}

/**
 * Returns the first window, hidden as the no-GUI contract requires, with the
 * console/CSP probes installed and a reload so nothing on the first paint is
 * missed.
 */
export async function firstAppWindow(app) {
  const page = await app.firstWindow({ timeout: ELECTRON_LAUNCH_TIMEOUT_MS });
  const browserWindow = await app.browserWindow(page);
  if (await browserWindow.evaluate((win) => win.isVisible())) {
    fail('MFH_E2E_NO_GUI=1 时 Electron 窗口必须保持隐藏');
  }
  await page.waitForLoadState('domcontentloaded');
  const problems = watchPage(page);
  await installCspProbe(page);
  await installUiProbe(page);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.mfh-sider').waitFor({ state: 'visible', timeout: 20000 });
  await tid(page, 'page-title').waitFor({ state: 'visible', timeout: 20000 });
  return { page, browserWindow, problems };
}
