/* Browser E2E for the renderer against a synthetic bridge.
 *
 * CODE-02: `expectText` used to call `page.getByText()` over the whole
 * document, so it matched elements hidden by CSS *and* stale <main> elements
 * the SPA had already swapped out — a page could lose a string entirely and the
 * assertion would still pass off the previous page's leftovers. Every text
 * assertion here is now scoped to the *currently visible* <main> (or an
 * explicit container) and uses innerText, which excludes hidden nodes and
 * collapsed <details> content.
 *
 * CODE-03: the clock is frozen with a fixed instant and all expected dates are
 * derived from it, and the HTTP server + browser live in one guarded scope so a
 * failed Chromium launch cannot leak a listening socket.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fail, runSuite, withCleanup } from './_shared.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

const LAUNCH_TIMEOUT_MS = 60000;

/* Frozen "now" (local time on purpose — the renderer works in local calendar
   days). Every date expectation below is derived from this constant with the
   same algorithm dashboard.html uses, so the suite never rots. */
const FIXED_NOW = new Date('2026-05-21T10:00:00');

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function startOfWeek(date) {
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = out.getDay() || 7;
  out.setDate(out.getDate() - day + 1);
  return out;
}
const EXPECTED_WEEK_FROM = ymd(startOfWeek(FIXED_NOW));
const EXPECTED_WEEK_TO = ymd(FIXED_NOW);

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const fullPath = normalize(join(root, requested));

    if (!fullPath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const body = await readFile(fullPath);
      res.writeHead(200, { 'content-type': mime.get(extname(fullPath)) || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

const ACTIVE_MAIN = 'main.main:not([style*="display: none"])';

function activeMain(page, selector) {
  return page.locator(`${ACTIVE_MAIN} ${selector}`);
}

/**
 * Asserts that `text` is visible inside `scope` (default: the <main> currently
 * on screen). innerText excludes display:none / visibility:hidden subtrees and
 * closed <details>, so this cannot be satisfied by hidden markup or by a stale
 * SPA page that is still in the DOM but hidden.
 */
async function expectText(page, text, scope = ACTIVE_MAIN) {
  const found = await page.evaluate(({ sel, needle }) => {
    const el = document.querySelector(sel);
    return Boolean(el && el.innerText.includes(needle));
  }, { sel: scope, needle: text });
  if (!found) fail(`当前可见的「${scope}」中缺少文字：${text}`);
}

async function expectNoText(page, text, scope = ACTIVE_MAIN) {
  const found = await page.evaluate(({ sel, needle }) => {
    const el = document.querySelector(sel);
    return Boolean(el && el.innerText.includes(needle));
  }, { sel: scope, needle: text });
  if (found) fail(`当前可见的「${scope}」不应再出现文字：${text}`);
}

async function waitForText(page, text, scope = ACTIVE_MAIN, timeout = 8000) {
  await page.waitForFunction(({ sel, needle }) => {
    const el = document.querySelector(sel);
    return Boolean(el && el.innerText.includes(needle));
  }, { sel: scope, needle: text }, { timeout }).catch(() => {
    throw new Error(`等待「${scope}」出现文字超时：${text}`);
  });
}

/* Error toasts are sticky by design (FB-02): they stay until dismissed and can
   otherwise intercept clicks on the controls underneath. */
async function dismissToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.toast').forEach((toast) => toast.remove());
  });
}

async function main() {
  await withCleanup(async (scope) => {
    const { server, baseUrl } = await scope.use(
      '静态 HTTP server',
      startServer,
      ({ server: s }) => closeServer(s),
      { timeoutMs: 15000 },
    );
    void server;
    const browser = await scope.use(
      'Chromium',
      () => chromium.launch({ timeout: LAUNCH_TIMEOUT_MS }),
      (b) => b.close(),
      // Playwright's own graceful browser shutdown can take ~30s before it
      // SIGKILLs, so the release budget must sit above that.
      { timeoutMs: LAUNCH_TIMEOUT_MS + 10000, releaseTimeoutMs: 45000 },
    );

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // setFixedTime pins Date.now()/new Date() without pausing timers, so the
    // debounced autosave and the toast lifecycle still run normally.
    await page.clock.setFixedTime(FIXED_NOW);
    await page.addInitScript(() => {
      window.__savedConfigPayload = null;
      window.__afterMailDone = false;
      window.__afterFetchDone = false;
      window.__afterOcrDone = false;
      window.__bridgeCalls = [];
      // The real backend persists what saveConfig wrote, so getConfig must echo it.
      window.__ocrModeState = 'auto';
      const record = (name, payload) => {
        window.__bridgeCalls.push({ name, payload });
      };
      const inboxRowsFor = () => (window.__afterMailDone ? [
        {
          date: '2026-05-21T08:30:00.000Z',
          from: '国家电网 <noreply@example.com>',
          subject: '国家电网电子发票通知',
          mailbox: 'INBOX',
          hasAttachment: true,
          bodyLinkCount: 3,
        },
        {
          date: '2026-05-20T08:30:00.000Z',
          from: '服务商 <vendor@example.com>',
          subject: '普通通知',
          mailbox: 'INBOX',
          hasAttachment: false,
          bodyLinkCount: 0,
        },
      ] : []);
      window.mfhBridge = {
        async getSummary() {
          const history = Array.from({ length: 8 }, (_, index) => ({
            id: `hist-${index}`,
            time: new Date(Date.UTC(2026, 4, 21, 10, index)).toISOString(),
            action: index % 2 === 0 ? 'fetch' : 'ocr',
            title: index % 2 === 0 ? '获取邮件' : '识别发票文件',
            status: 'success',
            message: '已完成',
            detail: '测试记录',
            durationMs: 1200 + index,
          }));
          const inboxRows = inboxRowsFor();
          const libraryRows = window.__afterFetchDone ? [
            {
              date: '2026-05-21',
              seller: window.__afterOcrDone ? '国家电网有限公司' : '待识别',
              invoiceNo: window.__afterOcrDone ? '123456' : '',
              amount: window.__afterOcrDone ? '¥ 318.42' : '',
              source: window.__afterOcrDone ? '本机识别' : '归档文件',
              filename: '国家电网-318.42.pdf',
              filePath: '/tmp/mfh-mock/invoices/国家电网-318.42.pdf',
              status: window.__afterOcrDone ? '完整' : '待补充',
              documentType: 'invoice',
            },
            {
              date: '2026-05-20',
              seller: '差旅平台',
              invoiceNo: 'TRIP-1',
              amount: '¥ 88.00',
              source: '本机识别',
              filename: 'trip.pdf',
              filePath: '/tmp/mfh-mock/invoices/trip.pdf',
              status: '待补充',
              documentType: 'itinerary',
            },
            {
              date: '2026-05-20',
              seller: '未识别销售方',
              invoiceNo: '',
              amount: '',
              source: '本机识别',
              filename: 'bad.pdf',
              filePath: '/tmp/mfh-mock/invoices/bad.pdf',
              status: '识别失败',
              error: '暂未识别',
              documentType: 'invoice',
            },
          ] : [];
          return {
            configExists: true,
            history,
            secrets: { imapPass: true },
            inbox: {
              total: inboxRows.length,
              withAttachment: inboxRows.filter((row) => row.hasAttachment).length,
              withLinks: inboxRows.filter((row) => row.bodyLinkCount > 0).length,
              earliestMonth: inboxRows.length ? '2026-05' : '',
              latestMonth: inboxRows.length ? '2026-05' : '',
              offset: 0,
              limit: 80,
              rows: inboxRows,
            },
            library: {
              total: window.__afterFetchDone ? 3 : 0,
              recognized: window.__afterOcrDone ? 2 : 0,
              failed: window.__afterFetchDone ? 1 : 0,
              ignored: window.__afterFetchDone ? 1 : 0,
              pending: window.__afterFetchDone && !window.__afterOcrDone ? 3 : 0,
              invoiceLike: window.__afterFetchDone ? 2 : 0,
              itinerary: window.__afterFetchDone ? 1 : 0,
              supporting: window.__afterFetchDone ? 1 : 0,
              offset: 0,
              limit: 80,
              ocr: {
                byDocumentType: window.__afterFetchDone ? [
                  { key: 'invoice', count: 2 },
                  { key: 'itinerary', count: 1 },
                  { key: 'supporting', count: 1 },
                ] : [],
              },
              rows: libraryRows,
            },
            pending: {
              total: 1,
              groups: [
                {
                  title: '下载失败或链接过期',
                  count: 1,
                  action: 'refresh_link',
                  description: '需要重新打开平台或手动保存。',
                  rows: [
                    {
                      hash: 'abc123def456',
                      date: '2026-05-21',
                      from: 'vendor@example.com',
                      subject: '发票下载链接已过期',
                      reason: 'http_403:GET:https://vendor.example.com/d?token=secret-token',
                    },
                  ],
                },
              ],
            },
          };
        },
        async getConfig() {
          return {
            configExists: true,
            secrets: { imapPass: true, tencentSecretId: false, tencentSecretKey: false },
            config: {
              // The main process redacts secrets before they cross IPC.
              imap: { host: 'imap.test.local', port: 993, user: 'user@test.local', pass: '', tls: true, mailbox: ['INBOX'] },
              filter: { keywords: ['发票', '行程单'], matchSubject: true, matchBody: true },
              paths: { samples: './samples/raw', invoices: './invoices', pending: './pending' },
              output: { csv: './invoices.csv' },
              rename: {
                rule: '{seller}-{amount}.pdf',
                fallback: '{date}-{messageId}.pdf',
                typeDirRule: '{documentType}',
                avoidConflictBeforeOcr: true,
                applyAfterOcr: false,
                organizeByType: false,
              },
              ocr: {
                enabled: true,
                provider: 'efapiao',
                ocrMode: window.__ocrModeState,
                executionMode: 'auto',
                resultsCsv: './invoices/ocr/ocr-results.csv',
                serviceHost: '127.0.0.1',
                servicePort: 8000,
                serviceWorkers: 1,
                batchSize: 16,
                credentials: { tencentRegion: 'ap-shanghai' },
              },
              playwright: { timeoutMs: 30000 },
              network: { retries: 3, retryDelayMs: 1000 },
            },
          };
        },
        async getAppInfo() {
          return { version: '9.8.7', channel: '测试渠道', packaged: false, platform: 'test', arch: 'test', electron: '0' };
        },
        async startFetch(payload) {
          record('startFetch', payload);
          const normalizedFilter = {
            matchSubject: payload.matchSubject,
            matchBody: payload.matchBody,
            keywords: ['发票', '行程单'],
          };
          if (payload?.dryRun === true) {
            // Contract: a preview returns no `batch` at all.
            return { ok: true, normalizedFilter, summary: await window.mfhBridge.getSummary() };
          }
          window.__afterMailDone = true;
          const rows = inboxRowsFor();
          return {
            ok: true,
            batch: { rows, total: rows.length },
            normalizedFilter,
            summary: await window.mfhBridge.getSummary(),
          };
        },
        async runOcr(payload) {
          record('runOcr', payload);
          if (payload?.concurrency !== 1) throw new Error(`runOcr should default to concurrency=1, got ${JSON.stringify(payload)}`);
          window.__ocrProgress?.({ operation: 'ocr', phase: '开始识别', percent: 10, total: 3, processed: 0, parsed: 0, skipped: 0, failed: 0, message: '发现 3 个待识别文件，正在启动识别。' });
          window.__ocrProgress?.({ operation: 'ocr', phase: '正在识别', percent: 50, total: 3, processed: 1, parsed: 1, skipped: 0, failed: 0, message: '识别成功：国家电网-318.42.pdf', kind: 'ok' });
          window.__ocrProgress?.({ operation: 'ocr', phase: '识别完成', percent: 100, total: 3, processed: 3, parsed: 2, skipped: 1, failed: 0, message: '识别完成：成功 2 个，跳过 1 个，失败 0 个。', kind: 'ok', done: true });
          window.__afterOcrDone = true;
          return { ok: true, message: '已扫描 3 个文件，识别成功 2 个，跳过 1 个，失败 0 个。', summary: await window.mfhBridge.getSummary() };
        },
        async organize(payload) {
          record('organize', payload);
          return { ok: true, message: '改名完成，处理 2 条识别结果。' };
        },
        async runPipeline(payload) {
          record('runPipeline', payload);
          if (payload?.avoidConflictBeforeOcr !== true || payload?.force !== false) throw new Error(`runPipeline should default to force=false, got ${JSON.stringify(payload)}`);
          window.__fileProgress?.({ operation: 'files', phase: '开始获取', percent: 10, processed: 0, skipped: 0, failed: 0, message: '正在从本地邮件中获取发票文件。' });
          window.__fileProgress?.({ operation: 'files', phase: '正在获取', percent: 60, processed: 1, skipped: 0, failed: 0, message: '已获取：国家电网电子发票通知', kind: 'ok' });
          window.__fileProgress?.({ operation: 'files', phase: '获取完成', percent: 100, processed: 2, skipped: 0, failed: 0, message: '获取完成：处理 2 封，跳过 0 封，失败 0 封。', kind: 'ok', done: true });
          window.__afterFetchDone = true;
          return {
            ok: true,
            message: '已从本地邮件中获取发票文件。',
            batch: { rows: inboxRowsFor(), total: 2 },
            summary: await window.mfhBridge.getSummary(),
          };
        },
        async openPath(payload) {
          record('openPath', payload);
          return { ok: true };
        },
        async copyText(payload) {
          record('copyText', payload);
          return { ok: true };
        },
        async stopOcr() {
          record('stopOcr');
          return { ok: true, message: '正在停止识别。' };
        },
        async testMailConnection() {
          record('testMailConnection');
          return { ok: true, message: '邮箱连接正常，可以获取邮件。' };
        },
        async listMailboxes() {
          record('listMailboxes');
          return { ok: true, mailboxes: ['INBOX', 'Sent Messages', '邮件归档'] };
        },
        async pendingRefreshLink(payload) {
          record('pendingRefreshLink', payload);
          return { ok: true, message: '已尝试打开原始邮件，请在邮件中点击下载链接刷新授权后重新抓取。' };
        },
        async pendingIgnore(payload) {
          record('pendingIgnore', payload);
          return { ok: true, summary: await window.mfhBridge.getSummary() };
        },
        async pendingManualArchive(payload) {
          record('pendingManualArchive', payload);
          return { ok: true, message: '已归档', summary: await window.mfhBridge.getSummary() };
        },
        async developerReset() {
          record('developerReset');
          return {
            ok: true,
            removed: ['samples/raw'],
            skippedExternal: ['发票归档目录：…/invoices'],
            summary: await window.mfhBridge.getSummary(),
          };
        },
        async saveConfig(payload) {
          record('saveConfig', payload);
          window.__savedConfigPayload = payload;
          if (payload?.ocr?.ocrMode) window.__ocrModeState = payload.ocr.ocrMode;
          return { ok: true };
        },
        async getOpState() { return { running: null }; },
        onOpState() {},
        onFetchProgress(callback) {
          window.__fetchProgress = callback;
        },
        onOperationProgress(callback) {
          window.__ocrProgress = callback;
        },
        onFileProgress(callback) {
          window.__fileProgress = callback;
        },
      };
    });

    await page.goto(`${baseUrl}/pages/dashboard.html`);
    await page.waitForURL(`${baseUrl}/pages/dashboard.html`);
    await page.waitForFunction(() => Boolean(window.FPH?.configPayload));

    const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (theme !== 'light') fail(`默认主题应为亮色，实际为 ${theme}`);

    // Navigation labels live in the sidebar, not in <main>.
    await expectText(page, '开始处理', '.sidebar');
    await expectText(page, '邮件记录', '.sidebar');
    await expectText(page, '发票库', '.sidebar');
    await expectText(page, '待确认', '.sidebar');
    // COPY-03: credentials may only read as "saved", never as verified, until a
    // real connection test succeeds.
    // UI-03: the visible label is deliberately short so the full address cannot
    // squeeze the clock and theme button; the address moved to `title`. Assert
    // both halves so shortening the label cannot silently drop the address.
    await expectText(page, '已保存', '.sidebar');
    await expectNoText(page, '已连接', '.sidebar');
    const mailStatusTitle = await page.locator('.sidebar [data-mail-status-label]').first().getAttribute('title');
    if (!mailStatusTitle || !mailStatusTitle.includes('已保存 · user@test.local')) {
      fail(`侧栏邮箱状态的 title 应包含完整地址，实际为 ${JSON.stringify(mailStatusTitle)}`);
    }
    // COPY-07B: the version pill must come from getAppInfo, not hardcoded HTML.
    await expectText(page, 'v9.8.7', '.sidebar');

    await expectText(page, '获取发票文件');
    await expectText(page, '获取发票文件实时日志');
    await expectText(page, '识别发票文件');
    await expectText(page, '识别发票文件实时日志');
    await expectText(page, '获取邮件');
    await expectText(page, '获取邮件实时日志');
    await expectText(page, '最多显示最近 6 条记录');
    await expectText(page, '已获取邮件');
    await expectText(page, '选择日期范围后，点击「获取邮件」才会运行');

    const dashboardOrder = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .page h3`)).map((el) => el.textContent.trim()), ACTIVE_MAIN);
    // COPY-16 统一了「抓取/获取」用语：本次抓取邮件清单 -> 本次获取的邮件。
    const expectedOrder = ['第一步：获取邮件', '获取邮件实时日志', '第二步：获取发票文件', '获取发票文件实时日志', '第三步：识别发票文件（可选）', '识别发票文件实时日志', '本次获取的邮件', '最近运行'];
    for (let i = 0; i < expectedOrder.length; i++) {
      if (dashboardOrder[i] !== expectedOrder[i]) fail(`开始处理页区块顺序错误：${JSON.stringify(dashboardOrder)}`);
    }

    // FB-01: progress must be exposed as an accessible progressbar, not just CSS.
    const progressSemantics = await activeMain(page, '#run-progress').evaluate((el) => ({
      role: el.getAttribute('role'),
      now: el.getAttribute('aria-valuenow'),
      label: el.getAttribute('aria-label'),
      bar: getComputedStyle(el.querySelector('#prog-bar')).getPropertyValue('--p').trim(),
    }));
    if (progressSemantics.role !== 'progressbar' || progressSemantics.now !== '0' || !progressSemantics.label) {
      fail(`获取邮件进度缺少可访问语义：${JSON.stringify(progressSemantics)}`);
    }
    if (progressSemantics.bar !== '0%') fail(`页面打开时进度条不应启动，实际为 ${progressSemantics.bar}`);

    // P2-16: ⌘K/Ctrl+K 应聚焦侧边搜索框
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });
    const cmdKFocused = await page.evaluate(() => document.activeElement?.matches('[data-global-search]'));
    if (!cmdKFocused) fail('⌘K 应聚焦全局搜索框');
    // COPY-07A: no badge may advertise a shortcut that does not exist.
    const sidebarShortcuts = await page.locator('.sidebar').evaluate((el) => Array.from(el.querySelectorAll('kbd')).map((k) => k.textContent.trim()));
    if (sidebarShortcuts.some((label) => /R$/i.test(label))) {
      fail(`侧栏仍展示不存在的 ⌘R 快捷键：${JSON.stringify(sidebarShortcuts)}`);
    }

    /* ---------- Date range, derived from the frozen clock ------------------ */
    await page.getByRole('button', { name: '本周以来' }).click();
    const weekRange = await page.evaluate(() => ({
      from: document.querySelector('#date-from')?.value,
      to: document.querySelector('#date-to')?.value,
      preview: document.querySelector('#range-preview')?.textContent,
    }));
    if (weekRange.from !== EXPECTED_WEEK_FROM || weekRange.to !== EXPECTED_WEEK_TO) {
      fail(`本周以来日期填充错误：期望 ${EXPECTED_WEEK_FROM}~${EXPECTED_WEEK_TO}，实际 ${JSON.stringify(weekRange)}`);
    }
    if (!weekRange.preview?.includes(`${EXPECTED_WEEK_FROM} 至 ${EXPECTED_WEEK_TO}`)) {
      fail(`日期范围预览错误：${weekRange.preview}`);
    }
    // A reversed range must block the run instead of silently querying nothing.
    await page.locator('#date-from').fill(EXPECTED_WEEK_TO);
    await page.locator('#date-to').fill(EXPECTED_WEEK_FROM);
    const reversedState = await page.evaluate(() => ({
      disabled: document.getElementById('run-btn')?.disabled,
      preview: document.getElementById('range-preview')?.textContent,
    }));
    if (reversedState.disabled !== true || !reversedState.preview?.includes('晚于')) {
      fail(`开始日期晚于结束日期时应阻止运行：${JSON.stringify(reversedState)}`);
    }
    await page.getByRole('button', { name: '本周以来' }).click();

    const englishLeak = await activeMain(page, '.page').evaluate((el) => {
      const text = el.innerText;
      return /(WORKFLOW|SYSTEM|Quick find|Inbox|Library|Pending|Config|About|Completed|recognized|rule_unhandled|action=|manual_archive|travel_detail|order_detail|statement|meal_detail)/.exec(text)?.[0] || '';
    });
    if (englishLeak) fail(`页面仍暴露英文/内部状态：${englishLeak}`);

    /* ---------- Fetch ------------------------------------------------------ */
    // P0-6: 默认勾选状态下 startFetch payload 应带 matchSubject/matchBody=true 且 dryRun=false
    await page.getByRole('button', { name: '获取邮件' }).click();
    await waitForText(page, '完成', `${ACTIVE_MAIN} #run-status`);
    const startFetchPayload = await page.evaluate(() => window.__bridgeCalls.find((item) => item.name === 'startFetch')?.payload);
    if (!startFetchPayload || startFetchPayload.matchSubject !== true || startFetchPayload.matchBody !== true || startFetchPayload.dryRun !== false) {
      fail(`startFetch 默认 payload 应带 matchSubject/matchBody=true 且 dryRun=false：${JSON.stringify(startFetchPayload)}`);
    }
    if (startFetchPayload.from !== EXPECTED_WEEK_FROM || startFetchPayload.to !== EXPECTED_WEEK_TO) {
      fail(`startFetch 应原样透传本机日历日：${JSON.stringify(startFetchPayload)}`);
    }
    // APP-20: the batch table is scoped to what this run actually returned.
    await waitForText(page, '国家电网电子发票通知', `${ACTIVE_MAIN} [data-current-batch-rows]`);
    await expectText(page, '本次新增 2 封', `${ACTIVE_MAIN} [data-current-batch-note]`);
    // The backend echo of the normalised filter must be surfaced.
    await expectText(page, '本次实际使用：匹配主题 + 正文', `${ACTIVE_MAIN} [data-normalized-filter]`);

    // P0-6: 勾选「只预览，不保存」后 dryRun 必须为 true，且不得污染「本次抓取」
    await activeMain(page, '[data-fetch-check="dryRun"]').check();
    await page.getByRole('button', { name: '获取邮件' }).click();
    await waitForText(page, '完成', `${ACTIVE_MAIN} #run-status`);
    const dryRunPayload = await page.evaluate(() => window.__bridgeCalls.filter((item) => item.name === 'startFetch').at(-1)?.payload);
    if (!dryRunPayload || dryRunPayload.dryRun !== true) {
      fail(`勾选「只预览，不保存」后 dryRun 应为 true：${JSON.stringify(dryRunPayload)}`);
    }
    await expectText(page, '本次运行没有返回明细', `${ACTIVE_MAIN} [data-current-batch-rows]`);
    await activeMain(page, '[data-fetch-check="dryRun"]').uncheck();

    /* APP-20: subject + body may never both be off — with both cleared the run
       matches nothing while the backend quietly turns subject back on. Use
       click() rather than uncheck(): the renderer restores the second box on
       change, which uncheck() would report as a failed action. */
    await activeMain(page, '[data-fetch-check="matchSubject"]').click();
    await activeMain(page, '[data-fetch-check="matchBody"]').click();
    const matchScope = await page.evaluate((sel) => ({
      subject: document.querySelector(`${sel} [data-fetch-check="matchSubject"]`).checked,
      body: document.querySelector(`${sel} [data-fetch-check="matchBody"]`).checked,
    }), ACTIVE_MAIN);
    if (!matchScope.subject && !matchScope.body) {
      fail('「匹配主题」和「匹配正文」不应允许同时关闭');
    }
    await page.locator('.toast').getByText('至少需要一个匹配范围', { exact: false }).first().waitFor({ state: 'visible', timeout: 5000 });
    await dismissToasts(page);
    // Restore both scopes.
    await page.evaluate((sel) => {
      document.querySelectorAll(`${sel} [data-fetch-check="matchSubject"], ${sel} [data-fetch-check="matchBody"]`).forEach((el) => { el.checked = true; });
    }, ACTIVE_MAIN);

    const afterFetchMail = await page.evaluate(() => ({
      cached: document.querySelector('[data-dash="cached-mails"]')?.textContent?.trim(),
      navInbox: document.querySelector('[data-nav-badge="inbox"]')?.textContent?.trim(),
    }));
    if (afterFetchMail.cached !== '2' || afterFetchMail.navInbox !== '2') {
      fail(`获取邮件后已获取邮件统计没有刷新：${JSON.stringify(afterFetchMail)}`);
    }
    const afterFetchOcrCounts = await page.evaluate(() => ({
      invoice: document.querySelector('[data-dash="invoice-like"]')?.textContent?.trim(),
      itinerary: document.querySelector('[data-dash="itinerary"]')?.textContent?.trim(),
      supporting: document.querySelector('[data-dash="supporting"]')?.textContent?.trim(),
    }));
    if (afterFetchOcrCounts.invoice !== '0' || afterFetchOcrCounts.itinerary !== '0' || afterFetchOcrCounts.supporting !== '0') {
      fail(`获取邮件后不应已经生成发票文件统计：${JSON.stringify(afterFetchOcrCounts)}`);
    }

    await page.getByRole('link', { name: /邮件记录/ }).click();
    await page.waitForURL(`${baseUrl}/pages/inbox.html`);
    await waitForText(page, '国家电网电子发票通知', `${ACTIVE_MAIN} [data-inbox-rows]`);
    await page.getByRole('link', { name: /开始处理/ }).click();
    await page.waitForURL(`${baseUrl}/pages/dashboard.html`);

    /* ---------- Pipeline --------------------------------------------------- */
    await page.getByRole('button', { name: '获取发票文件' }).click();
    await waitForText(page, '获取完成：处理 2 封，跳过 0 封，失败 0 封。', `${ACTIVE_MAIN} [data-file-log]`);
    await dismissToasts(page);
    await activeMain(page, '[data-action="open-invoices-folder"]').first().click();
    await dismissToasts(page);
    const fileProgress = await activeMain(page, '[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (fileProgress !== '100%') fail(`获取发票文件进度应到 100%，实际为 ${fileProgress}`);
    const logStyles = await page.evaluate((sel) => {
      const scopeEl = document.querySelector(sel);
      const styleOf = (el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, height: style.height, overflowY: style.overflowY };
      };
      return {
        file: styleOf(scopeEl.querySelector('[data-file-log]')),
        ocr: styleOf(scopeEl.querySelector('[data-ocr-log]')),
        mail: styleOf(scopeEl.querySelector('#console-out')),
      };
    }, ACTIVE_MAIN);
    if (logStyles.file.background !== logStyles.ocr.background || logStyles.file.height !== logStyles.ocr.height || logStyles.file.overflowY !== 'auto') {
      fail(`获取/识别日志样式不一致或不可滚动：${JSON.stringify(logStyles)}`);
    }
    const afterFiles = await page.evaluate(() => ({
      invoice: document.querySelector('[data-dash="invoice-like"]')?.textContent?.trim(),
      itinerary: document.querySelector('[data-dash="itinerary"]')?.textContent?.trim(),
      supporting: document.querySelector('[data-dash="supporting"]')?.textContent?.trim(),
    }));
    if (afterFiles.invoice !== '2' || afterFiles.itinerary !== '1' || afterFiles.supporting !== '1') {
      fail(`获取发票文件后统计不正确：${JSON.stringify(afterFiles)}`);
    }

    /* ---------- OCR -------------------------------------------------------- */
    await activeMain(page, '[data-action="rename-organize"]').first().click();
    await dismissToasts(page);
    await page.getByRole('button', { name: '开始识别' }).click();
    await waitForText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。', `${ACTIVE_MAIN} [data-ocr-log]`);
    await dismissToasts(page);
    const ocrProgress = await activeMain(page, '[data-ocr-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (ocrProgress !== '100%') fail(`识别进度应到 100%，实际为 ${ocrProgress}`);
    // FB-01: the terminal state must also reach assistive technology.
    await waitForText(page, '识别完成', '#mfh-live-status');

    await page.getByRole('button', { name: '操作预览' }).click();
    await dismissToasts(page);
    const dashboardCalls = await page.evaluate(() => window.__bridgeCalls.map((item) => item.name));
    for (const expected of ['startFetch', 'runPipeline', 'openPath', 'organize', 'runOcr']) {
      if (!dashboardCalls.includes(expected)) fail(`控制台按钮没有调用 ${expected}: ${dashboardCalls.join(',')}`);
    }
    const historyCards = await activeMain(page, '[data-run-history] .history-item').count();
    if (historyCards > 6) fail(`最近运行最多显示 6 条，实际 ${historyCards}`);

    /* ---------- Pending ---------------------------------------------------- */
    await page.getByRole('link', { name: /待确认/ }).click();
    await page.waitForURL(`${baseUrl}/pages/pending.html`);
    await page.getByRole('link', { name: /开始处理/ }).click();
    await page.waitForURL(`${baseUrl}/pages/dashboard.html`);
    const preservedFileProgress = await activeMain(page, '[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (preservedFileProgress !== '100%') fail(`页面切换后获取发票进度不应丢失，实际为 ${preservedFileProgress}`);
    await page.getByRole('link', { name: /待确认/ }).click();
    await page.waitForURL(`${baseUrl}/pages/pending.html`);
    /* COPY-12: the banner must no longer assert a cause it cannot know (the old
       copy claimed "这些邮件大多是历史链接过期" unconditionally). It now states
       only what is true — these need confirmation — and the per-card reason
       carries the actual cause. */
    await expectText(page, '这些邮件需要你确认后才能继续');
    await expectNoText(page, '大多是历史链接过期');
    await expectText(page, '发票下载链接已过期');
    /* COPY-05: the visible card must show a human category and next step; the
       machine reason may only live inside the collapsed 诊断信息 disclosure, and
       even there the signed URL and the full hash must be redacted. */
    await expectNoText(page, 'http_403');
    await expectNoText(page, 'secret-token');
    await expectNoText(page, 'abc123def456');
    await expectText(page, '链接过期', `${ACTIVE_MAIN} .pending-item`);
    const diagnostics = await activeMain(page, '.pending-item .toast__detail').first().evaluate((el) => ({
      collapsed: !el.open,
      text: el.textContent || '',
    }));
    if (!diagnostics.collapsed) fail('诊断信息应默认折叠，不应成为卡片的主要文案');
    if (!diagnostics.text.includes('支持编号：ABC123')) fail(`诊断信息缺少脱敏支持编号：${diagnostics.text}`);
    if (diagnostics.text.includes('secret-token') || diagnostics.text.includes('abc123def456')) {
      fail(`诊断信息里的链接参数/完整编号没有脱敏：${diagnostics.text}`);
    }

    // P0-8: pending Tab 切换应该真的过滤分组
    await activeMain(page, '[data-pending-tab="ignore"]').click();
    const ignorableGroups = await activeMain(page, '[data-pending-groups] .group').count();
    if (ignorableGroups !== 0) fail(`pending 「可忽略」Tab 应过滤掉 refresh_link 分组，实际剩 ${ignorableGroups} 组`);
    await activeMain(page, '[data-pending-tab="refresh_link"]').click();
    const refreshGroups = await activeMain(page, '[data-pending-groups] .group').count();
    if (refreshGroups !== 1) fail(`pending 「刷新链接」Tab 应保留 refresh_link 分组，实际 ${refreshGroups}`);
    await activeMain(page, '[data-pending-tab="all"]').click();
    // The collapsible group header must be a real button with aria-expanded.
    const groupHead = await activeMain(page, '.group__head').first().evaluate((el) => ({
      tag: el.tagName,
      expanded: el.getAttribute('aria-expanded'),
      controls: Boolean(el.getAttribute('aria-controls')),
    }));
    if (groupHead.tag !== 'BUTTON' || groupHead.expanded !== 'true' || !groupHead.controls) {
      fail(`待确认分组标题不是可访问的折叠按钮：${JSON.stringify(groupHead)}`);
    }

    await activeMain(page, '[data-action="pending-primary"]').click();
    await dismissToasts(page);
    await page.getByRole('button', { name: '打开待确认文件夹' }).first().click();
    await dismissToasts(page);
    await activeMain(page, '[data-action="copy-diagnostics"]').first().click();
    const copiedDiagnostics = await page.evaluate(() => window.__bridgeCalls.filter((c) => c.name === 'copyText').at(-1)?.payload?.text || '');
    if (!copiedDiagnostics.includes('支持编号：ABC123')) fail(`复制的诊断信息缺少支持编号：${copiedDiagnostics}`);
    if (copiedDiagnostics.includes('secret-token') || copiedDiagnostics.includes('abc123def456')) {
      fail(`复制的诊断信息没有脱敏：${copiedDiagnostics}`);
    }
    await dismissToasts(page);
    const genericToast = await page.locator('.toast').getByText('桌面版中会调用本地程序完成这一步', { exact: false }).count();
    if (genericToast > 0) fail('普通按钮不应再弹出泛化的桌面版提示');
    const pendingCalls = await page.evaluate(() => window.__bridgeCalls.map((item) => item.name));
    if (!pendingCalls.includes('openPath') || !pendingCalls.includes('copyText') || !pendingCalls.includes('pendingRefreshLink')) {
      fail(`待确认按钮没有调用文件夹/复制/刷新链接动作：${pendingCalls.join(',')}`);
    }

    /* ---------- Library ---------------------------------------------------- */
    await page.getByRole('link', { name: /发票库/ }).click();
    await page.waitForURL(`${baseUrl}/pages/library.html`);
    await activeMain(page, '[data-search="library"]').fill('国家电网');
    await waitForText(page, '国家电网有限公司', `${ACTIVE_MAIN} [data-library-rows]`);
    const badVisibleAfterSearch = await page.evaluate((sel) => document.querySelector(`${sel} [data-library-rows]`).innerText.includes('bad.pdf'), ACTIVE_MAIN);
    if (badVisibleAfterSearch) fail('发票库搜索没有过滤不匹配结果');
    await activeMain(page, '[data-search="library"]').fill('');

    /* P0-7: the standalone「仅失败项」checkbox was removed; status filtering is
       now owned entirely by the tab strip, whose labels come from the backend
       status enum. COPY-03 renamed the 待补充 tab to 「信息不完整」 for
       non-technical users; the filter still accepts the legacy 待补充 value. */
    if (await activeMain(page, '[data-filter="library-failed"]').count() !== 0) {
      fail('发票库不应同时存在 tab 和「仅失败项」两套状态筛选');
    }
    const tabLabels = await activeMain(page, '[data-library-tab]').evaluateAll((els) => els.map((el) => ({ key: el.dataset.libraryTab, label: el.textContent.trim() })));
    const expectedTabs = { all: '全部', recognized: '已识别', partial: '信息不完整', failed: '识别失败', supporting: '支撑材料', itinerary: '行程单' };
    for (const [key, label] of Object.entries(expectedTabs)) {
      const found = tabLabels.find((tab) => tab.key === key);
      if (!found) fail(`发票库缺少「${label}」筛选 tab：${JSON.stringify(tabLabels)}`);
      if (found.label !== label) fail(`发票库 tab 文案应与后端状态枚举一致，期望「${label}」，实际「${found.label}」`);
    }
    const rowsIn = async (tab) => {
      await activeMain(page, `[data-library-tab="${tab}"]`).click();
      return page.evaluate((sel) => (
        Array.from(document.querySelectorAll(`${sel} [data-library-rows] tr`)).filter((tr) => !tr.textContent.includes('没有找到')).length
      ), ACTIVE_MAIN);
    };
    if (await rowsIn('all') !== 3) fail('发票库「全部」应显示 3 行');
    // APP-20: 已识别 must mean 完整 only — partial rows may not be counted as recognised.
    if (await rowsIn('recognized') !== 1) fail('「已识别」只应包含状态为「完整」的行');
    if (await rowsIn('partial') !== 1) fail('「信息不完整」应只包含 partial 状态的行（含旧值「待补充」）');
    if (await rowsIn('failed') !== 1) fail('「识别失败」应只包含 1 行');
    await waitForText(page, 'bad.pdf', `${ACTIVE_MAIN} [data-library-rows]`);
    if (await rowsIn('itinerary') !== 1) fail('「行程单」应只包含 1 行');
    await rowsIn('all');

    // Sorting moved from the <th> itself to a button inside it, reported via aria-sort.
    await activeMain(page, 'th[data-sort-key="amount"] .th-sort').click();
    const sortState = await activeMain(page, 'th[data-sort-key="amount"]').getAttribute('aria-sort');
    if (sortState !== 'ascending') fail(`点击排序按钮后 aria-sort 应为 ascending，实际 ${sortState}`);
    await activeMain(page, 'th[data-sort-key="amount"] .th-sort').click();
    const sortStateDesc = await activeMain(page, 'th[data-sort-key="amount"]').getAttribute('aria-sort');
    if (sortStateDesc !== 'descending') fail(`再次点击应切换为 descending，实际 ${sortStateDesc}`);
    const otherSorted = await activeMain(page, 'th[data-sort-key="date"]').getAttribute('aria-sort');
    if (otherSorted !== 'none') fail(`同一时间只能有一列被标记为已排序，date 列实际为 ${otherSorted}`);

    await activeMain(page, '[data-library-rows]').getByRole('button', { name: '打开' }).first().click();
    await dismissToasts(page);
    const rerunClass = await activeMain(page, '[data-action="ocr-toggle"]').evaluate((el) => el.className);
    if (!String(rerunClass).includes('btn--primary')) fail(`发票库重新识别按钮不是蓝色主按钮：${rerunClass}`);
    const rerunLabel = await activeMain(page, '[data-action="ocr-toggle"]').textContent();
    if (rerunLabel?.trim() !== '重新识别') fail(`已有识别结果时库页按钮应显示「重新识别」，实际=${rerunLabel}`);
    page.once('dialog', (dialog) => dialog.accept());
    await activeMain(page, '[data-action="ocr-toggle"]').click();
    await waitForText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。', `${ACTIVE_MAIN} [data-ocr-log]`);
    await dismissToasts(page);
    const rerunPayload = await page.evaluate(() => window.__bridgeCalls.filter((item) => item.name === 'runOcr').at(-1)?.payload);
    if (rerunPayload?.resetResults !== true || rerunPayload?.force !== true) fail(`重新识别没有通过 runOcr 原子重置：${JSON.stringify(rerunPayload)}`);
    await activeMain(page, '[data-action="rename-organize"]').click();
    await dismissToasts(page);

    /* ---------- Inbox search ----------------------------------------------- */
    await page.getByRole('link', { name: /邮件记录/ }).click();
    await page.waitForURL(`${baseUrl}/pages/inbox.html`);
    await activeMain(page, '[data-search="inbox"]').fill('国家电网');
    await waitForText(page, '国家电网电子发票通知', `${ACTIVE_MAIN} [data-inbox-rows]`);
    const normalVisible = await page.evaluate((sel) => document.querySelector(`${sel} [data-inbox-rows]`).innerText.includes('普通通知'), ACTIVE_MAIN);
    if (normalVisible) fail('邮件搜索没有过滤不匹配结果');
    // The scope of search/filter must be stated honestly: only loaded rows.
    await activeMain(page, '[data-search="inbox"]').fill('');
    await expectText(page, '已加载全部 2 条记录', `${ACTIVE_MAIN} [data-load-more="inbox"]`);

    /* ---------- Config ----------------------------------------------------- */
    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(`${baseUrl}/pages/config.html`);
    await page.waitForFunction(() => Boolean(window.collectConfigPayload));
    await expectText(page, '先保存所有发票和行程单原件');
    await expectText(page, '这里只设置关键词');
    // COPY-02: the cloud disclosure must name what leaves the device.
    await expectText(page, '待识别的发票和行程单文件本身会被发送到腾讯云进行识别。');
    /* COPY-15: the credential fields are labelled in plain Chinese; the raw
       machine terms (SecretId / SecretKey) must not be the user-facing label. */
    await expectText(page, '腾讯云识别密钥 ID');
    await expectNoText(page, '腾讯云 SecretId');
    await expectText(page, '修改后自动保存');
    /* COPY-04: the destructive action must read as a data reset, not a cache purge.
       COPY-08: it must also not overstate its scope — the old heading claimed it
       deleted ALL local data while mail/save settings are in fact retained. */
    await expectText(page, '清空应用管理的数据（保留邮箱与保存设置）');
    await expectNoText(page, '将删除所有本机数据');
    // COPY-08: the body must state both what is deleted and what is retained.
    await expectText(page, '会永久删除应用内部保存的邮件、发票和行程单');
    await expectText(page, '邮箱与保存设置不会删除');
    // COPY-06 / APP-19 / CODE-08: retired jargon and dead settings must be gone.
    const removedConfigText = await activeMain(page, '.page').evaluate((el) => (
      /自定义日期范围|最近多少天|npx playwright install chromium|当前版本不会调用 LLM|桌面版会随应用准备浏览器|运行 efapiao 时会作为本地环境变量透传|efapiao（内置）|删除本机缓存/.exec(el.innerText)?.[0] || ''
    ));
    if (removedConfigText) fail(`设置页仍显示应移除的配置项/文案：${removedConfigText}`);
    if (await activeMain(page, '[data-config="playwright.browserManagement"]').count() !== 0) {
      fail('设置页仍暴露从未被读取的「应用自动准备浏览器」设置（APP-19）');
    }
    const saveButtonCount = await page.getByRole('button', { name: '保存并应用' }).count();
    if (saveButtonCount !== 0) fail('设置页不应再显示“保存并应用”按钮');

    // UI-02: every config field must be programmatically labelled.
    const unlabelled = await activeMain(page, '.page').evaluate((el) => (
      Array.from(el.querySelectorAll('input[data-config], select[data-config], input[data-config-check]'))
        .filter((field) => {
          if (field.getAttribute('aria-label')) return false;
          if (field.closest('label')) return false;
          return !(field.id && el.querySelector(`label[for="${field.id}"]`));
        })
        .map((field) => field.dataset.config || field.dataset.configCheck)
    ));
    if (unlabelled.length > 0) fail(`以下配置字段没有关联 label：${JSON.stringify(unlabelled)}`);

    const defaultVendor = await activeMain(page, '#ocr-vendor').inputValue();
    if (defaultVendor !== 'efapiao') fail(`默认识别后端应为 efapiao，实际为 ${defaultVendor}`);
    const defaultOcrMode = await activeMain(page, '#cfg-ocr-mode').inputValue();
    if (defaultOcrMode !== 'auto') fail(`默认识别模式应为 auto，实际为 ${defaultOcrMode}`);
    const mailboxSize = await activeMain(page, '.select--mailboxes').evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      size: el.getAttribute('size'),
    }));
    if (mailboxSize.height < 150 || mailboxSize.size !== '6') {
      fail(`邮箱文件夹选择框过小：${JSON.stringify(mailboxSize)}`);
    }

    await page.getByRole('button', { name: '测试邮箱连接' }).click();
    await page.locator('.toast').getByText('邮箱连接正常', { exact: false }).first().waitFor({ state: 'visible', timeout: 5000 });
    // Only a verified connection may upgrade the sidebar status to 已连接.
    /* UI-01: only a successful connection test may show the verified state.
       UI-03: the visible label stays short; the address lives in `title`. */
    await waitForText(page, '已连接', '.sidebar');
    const verifiedTitle = await page.locator('.sidebar [data-mail-status-label]').first().getAttribute('title');
    if (!verifiedTitle || !verifiedTitle.includes('已连接 · user@test.local')) {
      fail(`验证通过后侧栏 title 应包含完整地址，实际为 ${JSON.stringify(verifiedTitle)}`);
    }
    await dismissToasts(page);

    // Advanced settings are behind a disclosure now (COPY-06).
    await activeMain(page, 'details.card summary').first().click();
    /* COPY-15: the naming fields are presented as Chinese chips; the raw
       `{seller}` template syntax is an implementation detail and must not be the
       user-facing label. The token itself still lives in `data-token` so the
       insert action keeps working. */
    await expectText(page, '销售方');
    await expectText(page, '发票号码');
    await expectNoText(page, '{seller}');
    const tokenValues = await activeMain(page, '[data-token]').evaluateAll((els) => els.map((el) => el.dataset.token));
    for (const token of ['{seller}', '{invoiceNo}']) {
      if (!tokenValues.includes(token)) fail(`命名字段按钮缺少 ${token}：${JSON.stringify(tokenValues)}`);
    }
    const tlsAlignment = await activeMain(page, '.field--compact').evaluate((el) => {
      const label = el.querySelector('.field__label')?.getBoundingClientRect();
      const check = el.querySelector('.check')?.getBoundingClientRect();
      return label && check ? Math.abs(label.left - check.left) : 999;
    });
    if (tlsAlignment > 4) fail(`TLS 勾选框没有在标签下方对齐：${tlsAlignment}`);
    // UI-02: the renderer switched from div.check.is-on to a native checkbox.
    const checkTagNames = await activeMain(page, '.check').evaluateAll((els) => Array.from(new Set(els.map((el) => `${el.tagName}:${el.getAttribute('type')}`))));
    if (checkTagNames.length === 0 || checkTagNames.some((name) => name !== 'INPUT:checkbox')) {
      fail(`勾选框必须是原生 checkbox，实际：${JSON.stringify(checkTagNames)}`);
    }

    await activeMain(page, '#ocr-vendor').selectOption('efapiao');
    await activeMain(page, '#cfg-ocr-mode').selectOption('disabled');
    await activeMain(page, '#tencent-secret-id').fill('demo-secret-id');
    await activeMain(page, '#tencent-secret-key').fill('demo-secret-key');
    /* COPY-14: service topology (region, results path) now lives behind the
       「查看技术详情」 disclosure, so it must be opened before the field exists
       to the user. Opening it here also asserts the field is still reachable. */
    await activeMain(page, 'details:has(#tencent-region) > summary').first().click();
    await activeMain(page, '#tencent-region').fill('ap-guangzhou');
    // P0-1: 邮箱文件夹多选要保存进 imap.mailbox
    await activeMain(page, '.select--mailboxes').selectOption(['INBOX', 'Sent Messages']);
    // P0-2: TLS 勾选框要保存到 imap.tls
    await activeMain(page, '[data-config-check="imap.tls"]').uncheck();
    // P0-3 / P0-4: applyAfterOcr / organizeByType 勾选要保存
    await activeMain(page, '[data-config-check="rename.applyAfterOcr"]').check();
    await activeMain(page, '[data-config-check="rename.organizeByType"]').check();
    // P0-5: 网络重试两个输入框要绑定 network.*
    await activeMain(page, '[data-config="network.retries"]').fill('5');
    /* COPY-14: the retry interval is entered in SECONDS now (milliseconds are an
       internal unit a non-technical user should not have to think about) and is
       converted on collect. 2.5s === the 2500ms the payload assertions expect;
       typing 2500 here would exceed the 60s maximum and fail validation. */
    await activeMain(page, '[data-config="network.retryDelayMs"]').fill('2.5');
    await waitForText(page, '已保存到本机', `${ACTIVE_MAIN} #save-state`);
    await page.waitForFunction(() => window.__savedConfigPayload?.network?.retryDelayMs === 2500);
    const savedPayload = await page.evaluate(() => window.__savedConfigPayload);
    if (!Array.isArray(savedPayload?.imap?.mailbox) || savedPayload.imap.mailbox.length !== 2 || !savedPayload.imap.mailbox.includes('INBOX') || !savedPayload.imap.mailbox.includes('Sent Messages')) {
      fail(`邮箱文件夹多选未保存进 imap.mailbox：${JSON.stringify(savedPayload?.imap)}`);
    }
    if (savedPayload?.imap?.tls !== false) {
      fail(`TLS 勾选状态未保存到 imap.tls：${JSON.stringify(savedPayload?.imap)}`);
    }
    if (savedPayload?.rename?.applyAfterOcr !== true) {
      fail(`「识别后自动改名」未保存到 rename.applyAfterOcr：${JSON.stringify(savedPayload?.rename)}`);
    }
    if (savedPayload?.rename?.organizeByType !== true) {
      fail(`「按类型分目录」未保存到 rename.organizeByType：${JSON.stringify(savedPayload?.rename)}`);
    }
    if (savedPayload?.network?.retries !== 5 || savedPayload?.network?.retryDelayMs !== 2500) {
      fail(`网络重试设置未保存到 network.*：${JSON.stringify(savedPayload?.network)}`);
    }
    if (savedPayload?.ocr?.credentials?.tencentRegion !== 'ap-guangzhou') {
      fail(`配置保存没有携带腾讯 OCR 区域：${JSON.stringify(savedPayload?.ocr?.credentials)}`);
    }
    if (savedPayload?.ocr?.ocrMode !== 'disabled') {
      fail(`识别模式没有保存：${JSON.stringify(savedPayload?.ocr)}`);
    }
    if (savedPayload?.filter?.since || savedPayload?.filter?.until || savedPayload?.filter?.sinceDays) {
      fail(`设置页不应再写入日期过滤项：${JSON.stringify(savedPayload?.filter)}`);
    }
    if ('browserManagement' in (savedPayload?.playwright || {})) {
      fail(`设置页不应再写入无效的 playwright.browserManagement：${JSON.stringify(savedPayload?.playwright)}`);
    }

    // APP-21 / COPY-04: the reset needs two confirmations and must report what it skipped.
    let confirmCount = 0;
    page.on('dialog', async (dialog) => {
      confirmCount += 1;
      await dialog.accept();
    });
    await activeMain(page, '[data-action="developer-reset"]').click();
    await page.locator('.toast').getByText('仅重置了应用管理的数据', { exact: false }).first().waitFor({ state: 'visible', timeout: 5000 });
    if (confirmCount < 2) fail(`删除本机数据必须二次确认，实际只弹出 ${confirmCount} 次`);
    const resetToast = await page.locator('.toast').last().innerText();
    if (!resetToast.includes('应用目录之外')) {
      fail(`重置结果没有说明被跳过的外部位置：${resetToast}`);
    }
    // FB-02: toasts carry role=status/alert and an accessible close button.
    const resetToastSemantics = await page.locator('.toast').last().evaluate((el) => ({
      role: el.getAttribute('role'),
      closable: Boolean(el.querySelector('.toast__close')),
    }));
    if (!resetToastSemantics.closable) fail('toast 缺少可访问的关闭按钮');
    if (!['status', 'alert'].includes(resetToastSemantics.role)) {
      fail(`toast 缺少 role=status/alert：${JSON.stringify(resetToastSemantics)}`);
    }
    await dismissToasts(page);

    /* FB-02: repeated identical messages merge into one toast with a ×N badge
       instead of burying the screen, and the stack stays bounded. */
    const merged = await page.evaluate(() => {
      for (let i = 0; i < 3; i++) window.FPH.showToast('重复提示', '同一条消息', 'warn');
      const toasts = Array.from(document.querySelectorAll('.toast-stack .toast'));
      const repeated = toasts.find((el) => el.dataset.toastSignature?.includes('重复提示'));
      return {
        total: toasts.length,
        count: repeated?.dataset.toastCount,
        badge: repeated?.querySelector('.toast__repeat')?.textContent?.trim(),
      };
    });
    if (merged.total !== 1) fail(`同一条消息触发 3 次应只渲染 1 条 toast，实际 ${merged.total} 条`);
    if (merged.count !== '3' || merged.badge !== '×3') {
      fail(`重复 toast 应合并并显示 ×3，实际：${JSON.stringify(merged)}`);
    }
    await dismissToasts(page);

    // The stack is bounded, and distinct messages never collapse into each other.
    /* UI-07 gave toasts an exit animation, so a trimmed toast stays in the DOM
       marked `.is-leaving` until it finishes. Count only what the user actually
       still sees; the leak check below then proves the leaving ones are really
       removed rather than accumulating. */
    const bounded = await page.evaluate(() => {
      for (let i = 0; i < 8; i++) window.FPH.showToast(`不同提示 ${i}`, `第 ${i} 条`, 'warn');
      const toasts = Array.from(document.querySelectorAll('.toast-stack .toast:not(.is-leaving)'));
      return {
        visible: toasts.length,
        signatures: new Set(toasts.map((el) => el.dataset.toastSignature)).size,
      };
    });
    if (bounded.visible > 4) fail(`toast 栈应有可见数量上限（≤4），实际同时显示 ${bounded.visible} 条`);
    if (bounded.visible < 1) fail('toast 栈上限不应把所有提示都吃掉');
    if (bounded.signatures !== bounded.visible) {
      fail(`不同内容的 toast 被错误合并：${JSON.stringify(bounded)}`);
    }
    /* UI-07 leak check: every trimmed toast must actually leave the DOM once its
       exit animation finishes, otherwise the stack grows invisibly forever. */
    await page.waitForFunction(() => document.querySelectorAll('.toast-stack .toast').length <= 4, undefined, { timeout: 5000 })
      .catch(async () => {
        const total = await page.evaluate(() => document.querySelectorAll('.toast-stack .toast').length);
        fail(`退出动画结束后仍有 ${total} 个 toast 残留在 DOM 中`);
      });
    await dismissToasts(page);

    const configCalls = await page.evaluate(() => window.__bridgeCalls.map((item) => item.name));
    for (const expected of ['testMailConnection', 'saveConfig', 'developerReset']) {
      if (!configCalls.includes(expected)) fail(`设置页按钮没有调用 ${expected}: ${configCalls.join(',')}`);
    }

    /* ---------- About ------------------------------------------------------ */
    await page.getByRole('link', { name: '关于' }).click();
    await page.waitForURL(`${baseUrl}/pages/settings.html`);
    await expectText(page, '数据保存');
    await expectText(page, '识别与隐私');
    /* COPY-07B: version, channel, engine, cloud and mode must all come from the
       backend — including on the SPA path, which is how users actually reach
       About (showPage() now calls applyLiveState()/renderAppInfo() on commit).
       The same values are re-checked on a directly loaded page further down. */
    await expectText(page, 'v9.8.7');
    await expectText(page, '测试渠道');
    const aboutOcrMode = await activeMain(page, '[data-about-ocr-mode]').textContent();
    if (!aboutOcrMode?.includes('仅本地规则')) {
      fail(`关于页识别模式应反映刚保存的 disabled 配置，实际：${aboutOcrMode}`);
    }
    const aboutCloud = await activeMain(page, '[data-about-cloud]').textContent();
    if (!aboutCloud?.includes('未填写密钥')) {
      fail(`关于页云端状态必须来自真实配置（密钥已脱敏为空），实际：${aboutCloud}`);
    }
    const aboutLeak = await activeMain(page, '.page').evaluate((el) => /实施进度|设计原则|构建信息|扩展点|v0\.1\.0|本地预览版/.exec(el.innerText)?.[0] || '');
    if (aboutLeak) fail(`关于页仍暴露开发内容或硬编码版本：${aboutLeak}`);

    await page.getByTitle('切换到深色主题').click();
    const dark = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (dark !== 'dark') fail(`主题切换失败，实际为 ${dark}`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) fail('页面存在横向溢出');

    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(`${baseUrl}/pages/config.html`);
    const scrollCheck = await page.evaluate((sel) => {
      const scroller = document.querySelector(`${sel} .page`);
      if (!scroller) return { ok: false, before: 0, after: 0, max: 0 };
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = max;
      return { ok: max > 100 && scroller.scrollTop > 0, before: 0, after: scroller.scrollTop, max };
    }, ACTIVE_MAIN);
    if (!scrollCheck.ok) fail(`配置页不能纵向滚动：${JSON.stringify(scrollCheck)}`);

    const small = await scope.use(
      '窄窗口页面',
      () => browser.newPage({ viewport: { width: 900, height: 640 } }),
      (p) => p.close(),
      { timeoutMs: 30000 },
    );
    await small.goto(`${baseUrl}/pages/config.html`);
    const smallOverflow = await small.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (smallOverflow) fail('小窗口下页面存在横向溢出');

    /* COPY-07B: About must render real product metadata, never the hardcoded
       "v0.1.0 / 本地预览版" literals the report flagged. Asserted on a freshly
       loaded page so it exercises loadAppInfo() directly. */
    // Reload the primary page (which carries the mock bridge init script)
    // straight onto About so loadAppInfo() runs on a fresh document.
    await page.goto(`${baseUrl}/pages/settings.html`);
    await page.waitForFunction(() => Boolean(window.FPH?.appInfo));
    const aboutMeta = await page.evaluate(() => ({
      version: document.querySelector('[data-about-version]')?.textContent?.trim(),
      channel: document.querySelector('[data-about-channel]')?.textContent?.trim(),
      sidebar: document.querySelector('[data-app-version]')?.textContent?.trim(),
    }));
    if (aboutMeta.version !== 'v9.8.7' || aboutMeta.sidebar !== 'v9.8.7') {
      fail(`关于页/侧栏版本必须来自 getAppInfo：${JSON.stringify(aboutMeta)}`);
    }
    if (aboutMeta.channel !== '测试渠道') {
      fail(`关于页发布渠道必须来自 getAppInfo：${JSON.stringify(aboutMeta)}`);
    }
  });
}

await runSuite('GUI E2E', main, { timeoutMs: 5 * 60 * 1000 });
