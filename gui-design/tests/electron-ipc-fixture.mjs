/* Electron renderer + IPC fixture (renamed from "electron-full-flow", CODE-02).
 *
 * WHAT THIS COVERS: the real Electron main process, the real preload bridge, the
 * real IPC handlers and the real renderer, driven end to end through the UI.
 *
 * WHAT THIS DOES **NOT** COVER: the CLI. It runs with MFH_E2E_FAKE_CLI=1, so
 * `runCli()` is replaced by src/electron/devFakeBackend.ts — no mail is fetched,
 * nothing is extracted, downloaded or OCR'd. Calling that a "full flow" was the
 * false-positive this file is named to prevent. Real pipeline coverage lives in
 * gui-design/tests/cli-integration.mjs, which drives the compiled CLI itself.
 *
 * CODE-03: the clock is frozen (page.clock.setFixedTime) so date-range
 * assertions do not rot; every resource is acquired inside a guarded scope with
 * a launch timeout and process-tree termination.
 */

import { _electron as electron } from 'playwright';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertFreshBuild, closeElectronApp, fail, repoRoot, runSuite, useTempDir, withCleanup } from './_shared.mjs';

/* A fixed local instant. Everything the UI derives from "now" is computed from
   this constant with the same algorithm the renderer uses, so the suite is
   stable on any day and in any timezone. */
const FIXED_NOW = new Date('2026-05-21T10:00:00'); // local time, deliberately not UTC

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Same rule as dashboard.html: ISO weeks starting on Monday. */
function startOfWeek(date) {
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = out.getDay() || 7;
  out.setDate(out.getDate() - day + 1);
  return out;
}

const EXPECTED_WEEK_FROM = ymd(startOfWeek(FIXED_NOW));
const EXPECTED_WEEK_TO = ymd(FIXED_NOW);

const LAUNCH_TIMEOUT_MS = 60000;

function activeMain(page, selector) {
  return page.locator(`main.main:not([style*="display: none"]) ${selector}`);
}

/** Visible text assertion scoped to the page currently on screen. */
async function expectText(page, text, timeout = 8000) {
  await page.waitForFunction(({ needle }) => {
    const main = document.querySelector('main.main:not([style*="display: none"])');
    if (!main) return false;
    const visible = (el) => {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return Array.from(main.querySelectorAll('*')).some((el) => visible(el) && el.textContent?.includes(needle));
  }, { needle: text }, { timeout }).catch(() => {
    throw new Error(`当前可见页面缺少文字：${text}`);
  });
}

async function expectNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) fail(`${label} 存在横向溢出`);
}

async function expectToast(page, title) {
  await page.locator('.toast').getByText(title, { exact: false }).first().waitFor({ state: 'visible', timeout: 8000 });
}

/* Error toasts are sticky by design (FB-02), so they stack up and can cover
   controls. Dismiss them explicitly between steps instead of waiting them out. */
async function dismissToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.toast .toast__close').forEach((btn) => btn.click());
    document.querySelectorAll('.toast').forEach((toast) => toast.remove());
  });
}

/* Visible-text assertion inside one container of the active page.
   `innerText` already excludes elements hidden by CSS, so this stays correct
   across the responsive breakpoints that swap `.col-secondary` for `.cell-sub`
   without pinning the test to whichever copy happens to be first in the DOM. */
async function expectVisibleIn(page, containerSelector, needle, timeout = 8000) {
  await page.waitForFunction(({ sel, text }) => {
    const el = document.querySelector(`main.main:not([style*="display: none"]) ${sel}`);
    return Boolean(el && el.innerText.includes(text));
  }, { sel: containerSelector, text: needle }, { timeout }).catch(() => {
    throw new Error(`${containerSelector} 中看不到「${needle}」`);
  });
}

async function countRows(page, selector) {
  return activeMain(page, selector).evaluate((tbody) => (
    Array.from(tbody.querySelectorAll('tr')).filter((tr) => !tr.textContent.includes('暂无') && !tr.textContent.includes('没有找到')).length
  ));
}

async function goTo(page, linkName, urlPattern) {
  await dismissToasts(page);
  await page.getByRole('link', { name: linkName }).click();
  await page.waitForURL(urlPattern);
}

async function main() {
  await assertFreshBuild();

  await withCleanup(async (scope) => {
    const tmp = await useTempDir(scope, 'mfh-electron-ipc-');
    const configPath = join(tmp, 'config.json');
    const statePath = join(tmp, 'state.json');
    const userDataPath = join(tmp, 'user-data');
    await copyFile(join(repoRoot, 'config.example.json'), configPath);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.imap.host = 'imap.e2e.local';
    config.imap.user = 'e2e@example.com';
    config.imap.pass = 'e2e-password';
    config.filter.keywords = ['发票', '行程单'];
    config.paths.samples = join(tmp, 'samples', 'raw');
    config.paths.invoices = join(tmp, 'invoices');
    config.paths.pending = join(tmp, 'pending');
    // schema v3: output only carries `csv` (output.dir / output.pendingDir and
    // the whole `llm` block were removed as dead fields).
    config.output.csv = join(tmp, 'invoices.csv');
    config.ocr.resultsCsv = join(tmp, 'invoices', 'ocr', 'ocr-results.csv');
    config.ocr.ocrMode = 'auto';
    config.rename.organizedDir = join(tmp, 'invoices', 'organized');
    await mkdir(config.paths.samples, { recursive: true });
    await mkdir(config.paths.invoices, { recursive: true });
    await mkdir(config.paths.pending, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const app = await scope.use(
      'Electron 应用',
      () => electron.launch({
        cwd: repoRoot,
        args: ['.', `--user-data-dir=${userDataPath}`],
        timeout: LAUNCH_TIMEOUT_MS,
        env: {
          ...process.env,
          MFH_CONFIG_PATH: configPath,
          MFH_STATE_PATH: statePath,
          MFH_E2E_FAKE_CLI: '1',
        },
      }),
      // app.close() only reaches the top process (and can wedge); the CLI/OCR
      // children it spawned must not survive an aborted suite either.
      (launched) => closeElectronApp(launched),
      { timeoutMs: LAUNCH_TIMEOUT_MS + 10000 },
    );

    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await page.setViewportSize({ width: 1180, height: 780 });
    await page.waitForLoadState('domcontentloaded');

    // Freeze "now" before anything derives a date range from it, then re-run the
    // page so the dashboard presets are computed against the fixed instant.
    await page.clock.setFixedTime(FIXED_NOW);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expectText(page, '运行控制台');
    await expectNoHorizontalOverflow(page, '运行控制台');

    const bridgeType = await page.evaluate(() => typeof window.mfhBridge?.startFetch);
    if (bridgeType !== 'function') fail('Electron preload bridge 不可用');
    const opStateType = await page.evaluate(() => typeof window.mfhBridge?.getOpState);
    if (opStateType !== 'function') fail('preload 未暴露 getOpState（操作互斥契约）');

    await page.waitForURL(/dashboard\.html/);
    await expectText(page, '获取发票文件实时日志');
    await expectText(page, '识别发票文件实时日志');
    await expectText(page, '获取邮件实时日志');
    await expectText(page, '最多显示最近 6 条记录');
    await expectText(page, '已获取邮件');

    const initialProgress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (initialProgress !== '0%') fail(`初始进度应为 0%，实际为 ${initialProgress}`);
    const dashboardOrder = await page.evaluate(() => Array.from(document.querySelectorAll('main.main:not([style*="display: none"]) .page h3')).map((el) => el.textContent.trim()).slice(0, 8));
    const expectedOrder = ['第一步：获取邮件', '获取邮件实时日志', '第二步：获取发票文件', '获取发票文件实时日志', '第三步：识别发票文件（可选）', '识别发票文件实时日志', '本次抓取邮件清单', '最近运行'];
    for (let i = 0; i < expectedOrder.length; i++) {
      if (dashboardOrder[i] !== expectedOrder[i]) fail(`开始处理页区块顺序错误：${JSON.stringify(dashboardOrder)}`);
    }
    const logHeights = await page.evaluate(() => ({
      mail: getComputedStyle(document.querySelector('#console-out')).height,
      files: getComputedStyle(document.querySelector('[data-file-log]')).height,
      ocr: getComputedStyle(document.querySelector('[data-ocr-log]')).height,
    }));
    if (logHeights.mail !== logHeights.files || logHeights.files !== logHeights.ocr || parseFloat(logHeights.ocr) > 180) {
      fail(`日志窗口高度未统一缩短：${JSON.stringify(logHeights)}`);
    }

    /* ---------- Date range: derived from the frozen clock ------------------ */
    await page.getByRole('button', { name: '本周以来' }).click();
    const weekRange = await page.evaluate(() => ({
      from: document.querySelector('#date-from')?.value,
      to: document.querySelector('#date-to')?.value,
      preview: document.querySelector('#range-preview')?.textContent,
    }));
    if (weekRange.from !== EXPECTED_WEEK_FROM || weekRange.to !== EXPECTED_WEEK_TO) {
      fail(`「本周以来」应填入 ${EXPECTED_WEEK_FROM} 至 ${EXPECTED_WEEK_TO}，实际 ${JSON.stringify(weekRange)}`);
    }
    if (!weekRange.preview?.includes(`${EXPECTED_WEEK_FROM} 至 ${EXPECTED_WEEK_TO}`)) {
      fail(`日期范围预览错误：${weekRange.preview}`);
    }
    await page.getByRole('button', { name: '查看将要执行的操作' }).click();
    await expectToast(page, '将要执行');
    await dismissToasts(page);

    /* ---------- Stage 1a (fake CLI): dry-run fetch -------------------------
       APP-20 contract: a preview must say it saved nothing, must not touch the
       mail cache, and must NOT hand the dashboard a batch — "本次抓取" may only
       show rows an actual run returned. The fake CLI now receives the real argv
       and honours --dry-run, so the whole branch is exercised end to end. */
    await activeMain(page, '[data-fetch-check="dryRun"]').check();
    await page.getByRole('button', { name: '开始获取邮件' }).click();
    await page.locator('#run-status').getByText('完成', { exact: false }).waitFor({ state: 'visible', timeout: 15000 });
    const dryRunArgs = await page.evaluate(() => window.__mfhLastFetchArgs || []);
    if (!dryRunArgs.includes('--dry-run')) fail(`勾选「只预览，不保存」后应传 --dry-run：${JSON.stringify(dryRunArgs)}`);
    await expectVisibleIn(page, '#console-out', '预览完成：命中 2 封邮件，本次没有写入本机（预览模式）。');
    await expectVisibleIn(page, '[data-current-batch-rows]', '本次运行没有返回明细');
    // Nothing may have been written to disk by a preview.
    if (existsSync(join(config.paths.samples, 'INDEX.csv'))) {
      fail('「只预览，不保存」不应写入邮件索引 INDEX.csv');
    }
    const cachedAfterPreview = await readdir(config.paths.samples);
    if (cachedAfterPreview.length !== 0) {
      fail(`「只预览，不保存」不应在邮件缓存目录留下文件，实际：${JSON.stringify(cachedAfterPreview)}`);
    }
    const previewStats = await page.evaluate(() => ({
      cached: document.querySelector('[data-dash="cached-mails"]')?.textContent?.trim(),
      navInbox: document.querySelector('[data-nav-badge="inbox"]')?.textContent?.trim(),
    }));
    if (previewStats.cached !== '0' || previewStats.navInbox !== '0') {
      fail(`预览之后「已获取邮件」不应增长：${JSON.stringify(previewStats)}`);
    }
    await activeMain(page, '[data-fetch-check="dryRun"]').uncheck();

    /* ---------- Stage 1b (fake CLI): real fetch ---------------------------- */
    await page.getByRole('button', { name: '开始获取邮件' }).click();
    await page.locator('#run-status').getByText('完成', { exact: false }).waitFor({ state: 'visible', timeout: 15000 });
    await expectVisibleIn(page, '#console-out', '已保存 2 封新邮件，跳过 0 封已缓存邮件。');
    // The batch table is scoped to this run's rows (APP-20), not to the INDEX.
    await expectVisibleIn(page, '[data-current-batch-rows]', '国家电网电子发票通知');
    await expectVisibleIn(page, '[data-current-batch-note]', '本次新增 2 封');
    const batchRows = await countRows(page, '[data-current-batch-rows]');
    if (batchRows !== 2) fail(`「本次抓取邮件清单」应有 2 行，实际 ${batchRows}`);
    const progress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (progress !== '100%') fail(`抓取后进度应为 100%，实际为 ${progress}`);
    const fetchArgs = await page.evaluate(() => window.__mfhLastFetchArgs || []);
    const outIndex = fetchArgs.indexOf('--out');
    if (outIndex < 0 || fetchArgs[outIndex + 1] !== config.paths.samples) {
      fail(`获取邮件没有写入配置的邮件缓存目录：${JSON.stringify(fetchArgs)}`);
    }
    // The frozen clock must reach the backend arguments too.
    const sinceIndex = fetchArgs.indexOf('--since');
    const untilIndex = fetchArgs.indexOf('--until');
    if (fetchArgs[sinceIndex + 1] !== EXPECTED_WEEK_FROM || fetchArgs[untilIndex + 1] !== EXPECTED_WEEK_TO) {
      fail(`传给 CLI 的日期窗口与界面不一致：${JSON.stringify(fetchArgs)}`);
    }

    const afterFetch = await page.evaluate(() => ({
      cached: document.querySelector('[data-dash="cached-mails"]')?.textContent?.trim(),
      navInbox: document.querySelector('[data-nav-badge="inbox"]')?.textContent?.trim(),
      invoice: document.querySelector('[data-dash="invoice-like"]')?.textContent?.trim(),
      itinerary: document.querySelector('[data-dash="itinerary"]')?.textContent?.trim(),
      supporting: document.querySelector('[data-dash="supporting"]')?.textContent?.trim(),
    }));
    if (afterFetch.cached !== '2' || afterFetch.navInbox !== '2' || afterFetch.invoice !== '0' || afterFetch.itinerary !== '0' || afterFetch.supporting !== '0') {
      fail(`获取邮件后不应已经生成发票文件统计：${JSON.stringify(afterFetch)}`);
    }

    await goTo(page, /邮件记录/, /inbox\.html/);
    await expectVisibleIn(page, '[data-inbox-rows]', '国家电网电子发票通知');
    await goTo(page, '开始处理', /dashboard\.html/);

    /* ---------- Stage 2 (fake CLI): pipeline ------------------------------- */
    await page.getByRole('button', { name: '开始获取发票文件' }).click();
    await expectToast(page, '获取完成');
    await expectText(page, '获取完成：处理 2 封，跳过 0 封，失败 0 封。');
    await dismissToasts(page);
    await page.getByRole('button', { name: '打开归档目录' }).first().click();
    await expectToast(page, '已打开文件夹');
    await dismissToasts(page);
    const fileProgress = await page.locator('[data-file-bar]').first().evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (fileProgress !== '100%') fail(`获取发票文件后进度应为 100%，实际为 ${fileProgress}`);
    const afterFiles = await page.evaluate(() => ({
      invoice: document.querySelector('[data-dash="invoice-like"]')?.textContent?.trim(),
      itinerary: document.querySelector('[data-dash="itinerary"]')?.textContent?.trim(),
      supporting: document.querySelector('[data-dash="supporting"]')?.textContent?.trim(),
    }));
    if (afterFiles.invoice !== '1' || afterFiles.itinerary !== '1' || afterFiles.supporting !== '1') {
      fail(`获取发票文件后开始处理页统计不正确：${JSON.stringify(afterFiles)}`);
    }
    const archivedFiles = await readdir(config.paths.invoices);
    if (!archivedFiles.includes('0001.pdf') || !archivedFiles.includes('0002.pdf')) {
      fail(`获取发票文件后应先按数字顺序重命名，实际：${JSON.stringify(archivedFiles)}`);
    }

    await goTo(page, /发票库/, /library\.html/);
    await expectVisibleIn(page, '[data-library-rows]', '0001.pdf');
    await goTo(page, '开始处理', /dashboard\.html/);

    /* ---------- Stage 3 (fake CLI): OCR ------------------------------------ */
    await page.getByRole('button', { name: '开始识别发票文件' }).click();
    await expectToast(page, '识别完成');
    await expectText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。');
    await dismissToasts(page);
    const ocrProgress = await activeMain(page, '[data-ocr-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (ocrProgress !== '100%') fail(`识别后进度应为 100%，实际为 ${ocrProgress}`);
    const ocrArgs = await page.evaluate(() => window.__mfhLastOcrArgs || []);
    if (!ocrArgs.includes('--single-item') || ocrArgs.includes('--concurrency') || ocrArgs.includes('--force')) {
      fail(`Electron OCR 默认应使用 1 并行逐张续跑，实际：${JSON.stringify(ocrArgs)}`);
    }
    const afterOcr = await page.evaluate(() => ({
      recognized: document.querySelector('[data-dash="recognized"]')?.textContent?.trim(),
      historyCards: document.querySelectorAll('[data-run-history] .history-item').length,
    }));
    if (afterOcr.recognized !== '2' || afterOcr.historyCards > 6) {
      fail(`识别后统计不正确：${JSON.stringify(afterOcr)}`);
    }

    /* COPY-01: no IPC reply may carry raw subprocess output. The renderer only
       gets a structured code, a sanitised detail and a diagnostics reference;
       the full stdout/stderr stays in a 0600 file under .mfh-cache. */
    const ipcShape = await page.evaluate(async () => {
      const result = await window.mfhBridge.organize({ applyRename: false });
      return {
        keys: Object.keys(result),
        codeType: typeof result.code,
        code: result.code,
        exitCodeType: typeof result.exitCode,
        message: result.message,
      };
    });
    if (ipcShape.keys.includes('stdout') || ipcShape.keys.includes('stderr')) {
      fail(`IPC 返回值仍携带原始子进程输出：${JSON.stringify(ipcShape.keys)}`);
    }
    if (ipcShape.codeType !== 'string' || !/^organize_(done|failed)$/.test(ipcShape.code)) {
      fail(`IPC 返回的 code 应是结构化字符串：${JSON.stringify(ipcShape)}`);
    }
    if (ipcShape.exitCodeType !== 'number') fail(`IPC 返回值缺少数字 exitCode：${JSON.stringify(ipcShape)}`);
    if (!ipcShape.message || /[A-Za-z]{6,}/.test(ipcShape.message)) {
      fail(`IPC message 应是面向用户的中文文案：${JSON.stringify(ipcShape.message)}`);
    }
    await dismissToasts(page);

    await page.getByRole('button', { name: '一键改名' }).first().click();
    await expectToast(page, '改名完成');
    await dismissToasts(page);
    await page.getByRole('button', { name: '复制日志' }).click();
    await expectToast(page, '已复制');
    await dismissToasts(page);

    /* ---------- Navigation keeps committed progress ------------------------ */
    await goTo(page, /邮件记录/, /inbox\.html/);
    await goTo(page, '开始处理', /dashboard\.html/);
    const preservedFileProgress = await activeMain(page, '[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (preservedFileProgress !== '100%') fail(`页面切换后获取发票进度不应丢失，实际为 ${preservedFileProgress}`);

    /* ---------- Inbox ------------------------------------------------------ */
    await goTo(page, /邮件记录/, /inbox\.html/);
    await expectText(page, '邮件记录');
    await expectVisibleIn(page, '[data-inbox-rows]', '国家电网电子发票通知');
    await expectNoHorizontalOverflow(page, '邮件记录');
    await activeMain(page, '[data-search="inbox"]').fill('国家电网');
    const filteredInboxRows = await countRows(page, '[data-inbox-rows]');
    if (filteredInboxRows !== 1) fail(`邮件搜索后应只剩 1 行，实际 ${filteredInboxRows}`);
    await activeMain(page, '[data-search="inbox"]').fill('');
    // Sorting is driven by the header button and reported through aria-sort.
    await activeMain(page, 'th[data-sort-key="date"] .th-sort').click();
    const ariaSort = await activeMain(page, 'th[data-sort-key="date"]').getAttribute('aria-sort');
    if (ariaSort !== 'ascending') fail(`点击表头后 aria-sort 应为 ascending，实际 ${ariaSort}`);
    await activeMain(page, '[data-filter="inbox-attachment"]').click();
    const attachmentOnlyRows = await countRows(page, '[data-inbox-rows]');
    if (attachmentOnlyRows !== 1) fail(`「有附件」筛选后应只剩 1 行，实际 ${attachmentOnlyRows}`);
    await activeMain(page, '[data-filter="inbox-attachment"]').click();
    await page.getByRole('button', { name: '复制为 CSV' }).click();
    await expectToast(page, '已复制');
    await dismissToasts(page);
    await page.getByRole('button', { name: '打开邮件缓存' }).click();
    await expectToast(page, '已打开文件夹');
    await dismissToasts(page);

    /* ---------- Library ---------------------------------------------------- */
    await goTo(page, /发票库/, /library\.html/);
    await expectVisibleIn(page, '[data-library-rows]', '国家电网有限公司');
    await expectVisibleIn(page, '[data-library-rows]', '318.42');
    await expectNoHorizontalOverflow(page, '发票库');
    await activeMain(page, '[data-search="library"]').fill('国家电网');
    const filteredLibraryRows = await countRows(page, '[data-library-rows]');
    if (filteredLibraryRows !== 1) fail(`发票库搜索后应只剩 1 行，实际 ${filteredLibraryRows}`);
    await activeMain(page, '[data-search="library"]').fill('');
    await activeMain(page, '[data-library-tab="itinerary"]').click();
    const itineraryRows = await countRows(page, '[data-library-rows]');
    if (itineraryRows !== 1) fail(`「行程单」Tab 应只剩 1 行，实际 ${itineraryRows}`);
    await activeMain(page, '[data-library-tab="all"]').click();
    await expectVisibleIn(page, '[data-library-rows]', '0002.pdf');
    await activeMain(page, '[data-library-rows]').getByRole('button', { name: '打开' }).first().click();
    await expectToast(page, '已打开文件位置');
    await dismissToasts(page);
    await page.getByRole('button', { name: '打开归档目录' }).first().click();
    await expectToast(page, '已打开文件夹');
    await dismissToasts(page);
    page.once('dialog', (dialog) => dialog.accept());
    await activeMain(page, '[data-action="ocr-toggle"]').click();
    await expectToast(page, '识别完成');
    await expectText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。');
    await dismissToasts(page);
    await page.getByRole('button', { name: '一键改名' }).first().click();
    await expectToast(page, '改名完成');
    await dismissToasts(page);

    /* ---------- Pending ---------------------------------------------------- */
    await goTo(page, /待确认/, /pending\.html/);
    await expectText(page, '下载失败或链接过期');
    await expectText(page, '发票下载链接已过期');
    await expectNoHorizontalOverflow(page, '待确认');
    // Tabs are data-attribute driven; role+name matching now collides with the
    // collapsible group heading buttons that carry the same label.
    await activeMain(page, '[data-pending-tab="refresh_link"]').click();
    const refreshGroups = await activeMain(page, '[data-pending-group="refresh_link"]').count();
    if (refreshGroups !== 1) fail(`「刷新链接」Tab 应保留 refresh_link 分组，实际 ${refreshGroups}`);
    await activeMain(page, '[data-pending-tab="manual_archive"]').click();
    const manualGroups = await activeMain(page, '[data-pending-groups] .group').count();
    if (manualGroups !== 0) fail(`「手动归档」Tab 不应包含 refresh_link 分组，实际 ${manualGroups} 组`);
    await activeMain(page, '[data-pending-tab="all"]').click();

    await activeMain(page, '[data-action="pending-primary"]').first().click();
    await page.locator('.toast').first().waitFor({ state: 'visible', timeout: 8000 });
    await dismissToasts(page);
    await page.getByRole('button', { name: '打开待确认文件夹' }).first().click();
    await expectToast(page, '已打开文件夹');
    await dismissToasts(page);
    await activeMain(page, '[data-action="copy-diagnostics"]').first().click();
    await expectToast(page, '已复制');
    const diagnostics = await activeMain(page, '.pending-item .toast__detail pre').first().textContent();
    if (!diagnostics?.includes('支持编号')) fail(`待确认卡片缺少脱敏诊断信息：${diagnostics}`);
    await dismissToasts(page);
    await page.getByRole('button', { name: '复制为 CSV' }).click();
    await expectToast(page, '已复制');
    await dismissToasts(page);
    await page.getByRole('button', { name: '刷新列表' }).first().click();
    await expectToast(page, '已刷新');
    await dismissToasts(page);

    /* ---------- Config ----------------------------------------------------- */
    await goTo(page, '邮箱与保存', /config\.html/);
    await expectText(page, '配置');
    await expectNoHorizontalOverflow(page, '配置');
    await page.getByRole('button', { name: '测试邮箱连接' }).click();
    await expectToast(page, '邮箱连接正常');
    await dismissToasts(page);
    await expectText(page, '这里只设置关键词');
    await expectText(page, '{seller}');
    await expectText(page, '{invoiceNo}');
    // COPY-02: cloud recognition must state that the invoice files themselves leave the device.
    await expectText(page, '待识别的发票和行程单文件本身会被发送到腾讯云进行识别。');
    // COPY-06 / APP-19: implementation jargon and the dead browser setting are gone.
    const leakedConfigText = await activeMain(page, '.page').evaluate((page_) => (
      /自定义日期范围|最近多少天|npx playwright install chromium|当前版本不会调用 LLM|桌面版会随应用准备浏览器|本地环境变量透传/.exec(page_.innerText)?.[0] || ''
    ));
    if (leakedConfigText) fail(`设置页仍显示应移除的配置项/文案：${leakedConfigText}`);
    if (await activeMain(page, '[data-config="playwright.browserManagement"]').count() !== 0) {
      fail('设置页仍暴露无效的「应用自动准备浏览器」设置（APP-19）');
    }

    // Numeric validation must name the field and block the save (COPY-06).
    // Connection details now live in the collapsed 高级设置 disclosure.
    await activeMain(page, 'details.card summary').first().click();
    await activeMain(page, '[data-config="imap.port"]').fill('');
    await activeMain(page, '#save-state').getByText('未保存', { exact: false }).waitFor({ state: 'visible', timeout: 5000 });
    const portError = await activeMain(page, '[data-config="imap.port"] ~ .field__error').first().textContent();
    if (!portError?.includes('收件服务器端口') || !portError.includes('1–65535')) {
      fail(`清空端口后应给出字段名和取值范围，实际：${portError}`);
    }
    await activeMain(page, '[data-config="imap.port"]').fill('993');

    await page.getByLabel('是否识别').selectOption('efapiao');
    await page.getByLabel('云端识别').selectOption('disabled');
    await activeMain(page, '#tencent-region').fill('ap-guangzhou');
    await expectText(page, '已保存到本机');
    const savedConfig = JSON.parse(await readFile(configPath, 'utf8'));
    if (savedConfig.ocr.credentials.tencentRegion !== 'ap-guangzhou') {
      fail(`配置自动保存未写入腾讯云区域：${savedConfig.ocr.credentials.tencentRegion}`);
    }
    if (savedConfig.ocr.ocrMode !== 'disabled') {
      fail(`配置自动保存未正确写入识别模式：${JSON.stringify(savedConfig.ocr)}`);
    }
    if (savedConfig.filter.since || savedConfig.filter.until) {
      fail(`设置页不应再写入日期过滤项：${JSON.stringify(savedConfig.filter)}`);
    }
    if (savedConfig.imap.port !== 993) {
      fail(`端口修复后应保存为 993，实际 ${savedConfig.imap.port}`);
    }

    // Destructive reset: two confirmations, and the toast must not overstate it.
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '重置应用数据…' }).click();
    await expectToast(page, '仅重置了应用管理的数据');
    await dismissToasts(page);

    /* ---------- About ------------------------------------------------------ */
    await goTo(page, '关于', /settings\.html/);
    await expectText(page, '数据保存');
    await expectText(page, '识别与隐私');
    const aboutOcrMode = await activeMain(page, '[data-about-ocr-mode]').textContent();
    if (!aboutOcrMode?.includes('仅本地规则')) {
      fail(`关于页的识别模式应反映刚保存的 disabled 配置，实际：${aboutOcrMode}`);
    }
    await page.getByTitle('切换到深色主题').click();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (theme !== 'dark') fail(`主题切换失败，实际为 ${theme}`);
    await page.getByRole('button', { name: '打开保存位置' }).click();
    await expectToast(page, '已打开文件夹');
    await dismissToasts(page);
    await page.getByRole('button', { name: '打开待确认文件夹' }).click();
    await expectToast(page, '已打开文件夹');
    await dismissToasts(page);

    const smallWindow = await app.browserWindow(page);
    await smallWindow.evaluate((win) => win.setSize(900, 640));
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, '900x640 小窗口');
  });
}

await runSuite('Electron renderer/IPC fixture (fake CLI)', main, { timeoutMs: 5 * 60 * 1000 });
