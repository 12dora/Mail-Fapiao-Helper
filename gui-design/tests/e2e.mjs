/* Browser E2E for the React + antd renderer.
 *
 * WHAT THIS COVERS: the real bundle (gui-design/dist/app.js) served over HTTP
 * and driven with Playwright Chromium against the in-memory fake bridge
 * (`?fake=1` / `?fake=empty` / `?fake=broken`). Everything asserted here is
 * renderer behaviour: routing, run flow, tables, drawers, empty states, theme
 * and copy.
 *
 * WHAT THIS DOES **NOT** COVER: Electron, the preload bridge, the IPC handlers
 * or the CLI. Those live in electron-smoke.mjs / electron-ipc-fixture.mjs /
 * cli-*.mjs. A green run here says nothing about the backend.
 *
 * Selectors are the renderer's own `data-testid` hooks wherever antd internals
 * would otherwise leak into the suite; the antd-shaped ones are centralised in
 * ui-helpers.mjs.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fail, runSuite, withCleanup } from './_shared.mjs';
import {
  ROUTES,
  chipLabels,
  clickChip,
  closeDrawer,
  closeServer,
  cspViolations,
  dismissToasts,
  elementHeight,
  expectNoHorizontalOverflow,
  expectVisibleText,
  gotoRoute,
  installCspProbe,
  lintVisibleCopy,
  openApp,
  openRow,
  pageSizeOptions,
  pageTitle,
  rowCount,
  searchTable,
  setPageSize,
  startStaticServer,
  tableRows,
  tid,
  uiRoot,
  waitForToast,
  watchPage,
} from './ui-helpers.mjs';

const LAUNCH_TIMEOUT_MS = 60000;
const VIEWPORT = { width: 1360, height: 900 };

/** Assertion counter so the suite reports coverage instead of just "passed". */
let checks = 0;
function check(label, condition, detail = '') {
  checks++;
  if (!condition) fail(`${label}${detail ? `：${detail}` : ''}`);
}

/** The bundle is git-ignored; a missing one would silently test nothing. */
function assertRendererBuilt() {
  for (const file of ['dist/app.js', 'dist/app.css']) {
    if (!existsSync(join(uiRoot, file))) {
      fail(`缺少 gui-design/${file} —— 先运行 \`npm run build:renderer\`（浏览器套件跑的是构建产物）`);
    }
  }
}

async function newPage(context) {
  const page = await context.newPage();
  const problems = watchPage(page);
  await installCspProbe(page);
  return { page, problems };
}

/** No console error, no uncaught exception, no CSP violation — ever. */
async function assertClean(page, problems, where) {
  const violations = await cspViolations(page);
  check(`${where} 触发了 CSP 违规`, violations.length === 0, violations.join('; '));
  check(`${where} 输出了控制台错误`, problems.length === 0, problems.join('; '));
}

/* ---------------------------------------------------------------------------
 * 1. Shell: five routes, titles, no overflow
 * ------------------------------------------------------------------------ */

async function checkShell(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl);

  const navCount = await page.locator('[data-testid^="nav-"]').count();
  check('侧栏没有渲染出五个路由', navCount === ROUTES.length, `实际 ${navCount}`);

  for (const route of ROUTES) {
    await gotoRoute(page, route.key);
    const title = await pageTitle(page);
    check(`${route.key} 的标题不对`, title === route.title, `实际「${title}」`);
    const { hash } = new URL(page.url());
    check(`${route.key} 没有落在自己的 hash 上`, hash.startsWith(`#/${route.key}`), hash);
    await expectNoHorizontalOverflow(page, route.title);
    checks++;
  }

  // 哈希直达：截图脚本与发票库的「查看邮件」都靠它。
  await page.goto(`${baseUrl}/index.html?fake=1#/library`, { waitUntil: 'domcontentloaded' });
  await tid(page, 'page-title').waitFor({ state: 'visible' });
  check('哈希直达发票库失败', (await pageTitle(page)) === '发票库');

  await assertClean(page, problems, '路由切换');
  await page.close();
}

/* ---------------------------------------------------------------------------
 * 2. Dashboard: run flow, progress, log console
 * ------------------------------------------------------------------------ */

async function checkRunFlow(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl);

  // 日志卡必须撑满右列：旧界面把它钉死在固定高度，底部永远空一块。
  const runHeight = await elementHeight(page, 'run-card');
  const logHeight = await elementHeight(page, 'log-card');
  check(
    '运行日志没有填满右列',
    Math.abs(runHeight - logHeight) <= 2,
    `运行卡 ${runHeight.toFixed(1)}px / 日志卡 ${logHeight.toFixed(1)}px`,
  );

  const idle = await tid(page, 'log-console').innerText();
  check('空闲时日志面板没有给出下一步提示', idle.includes('点击'), idle.slice(0, 60));
  check('顶部运行提示条在空闲时不应出现', (await tid(page, 'op-banner').count()) === 0);

  await tid(page, 'action-run-start').click();

  await tid(page, 'op-banner').waitFor({ state: 'visible', timeout: 10000 });
  await expectVisibleText(page, '正在获取邮件');
  check('运行时「开始处理」没有置灰', await tid(page, 'action-run-start').isDisabled());
  checks++;

  // 三路进度事件都要落进同一个日志面板。
  for (const line of ['正在连接邮箱', '已完成，新增 18 封邮件', '已完成，新增 12 份发票']) {
    await page
      .waitForFunction(
        (needle) => document.querySelector('[data-testid="log-console"]')?.innerText.includes(needle),
        line,
        { timeout: 30000 },
      )
      .catch(() => fail(`运行日志里没有出现「${line}」`));
    checks++;
  }

  await waitForToast(page, '已完成，新增 12 份发票');
  await tid(page, 'op-banner').waitFor({ state: 'hidden', timeout: 30000 });
  checks += 2;

  const percent = await page.locator('.ant-progress-bg').first().getAttribute('style');
  check('运行结束后进度条不是 100%', /width:\s*100%/.test(percent ?? ''), percent ?? '');

  const batch = await rowCount(page, 'table-batch');
  check('「本次结果」没有回填本次运行的邮件', batch > 0, `实际 ${batch} 行`);

  const logLines = await page.locator('[data-testid="log-console"] .mfh-log__line').count();
  check('运行日志一行都没有', logLines >= 5, `实际 ${logLines} 行`);

  await dismissToasts(page);
  await assertClean(page, problems, '开始处理');
  await page.close();
}

/* ---------------------------------------------------------------------------
 * 3. Tables: search, chips, pagination
 * ------------------------------------------------------------------------ */

async function checkLibraryTable(page) {
  await gotoRoute(page, 'library');

  const chips = await chipLabels(page, 'table-library');
  check(
    '发票库的筛选项不完整',
    ['仅发票', '已识别', '待补充', '识别失败', '重复', '附属材料', '全部'].every((label) => chips.includes(label)),
    chips.join('/'),
  );

  // 默认「仅发票」：附属材料（费用汇总单一类）报销用不上，不该出现在首屏。
  const defaultRows = await tableRows(page, 'table-library').allInnerTexts();
  check('默认筛选没有藏起附属材料', !defaultRows.some((text) => text.includes('附属材料')));

  await clickChip(page, 'table-library', '附属材料');
  const supporting = await tableRows(page, 'table-library').allInnerTexts();
  check('「附属材料」筛选没有行', supporting.length > 0);
  check(
    '「附属材料」筛选混进了别的类型',
    supporting.every((text) => text.includes('附属材料')),
  );

  await clickChip(page, 'table-library', '重复');
  const duplicates = await tableRows(page, 'table-library').allInnerTexts();
  check('「重复」筛选没有行', duplicates.length > 0);
  check(
    '「重复」筛选里混进了不重复的行',
    duplicates.every((text) => text.includes('重复 ×')),
  );

  await clickChip(page, 'table-library', '全部');
  const all = await rowCount(page, 'table-library');
  check('默认每页应为 50 条', all === 50, `实际 ${all}`);

  const options = await pageSizeOptions(page, 'table-library');
  check(
    '每页条数选项应为 20/50/100',
    ['20 条/页', '50 条/页', '100 条/页'].every((option) => options.includes(option)),
    options.join('/'),
  );
  await setPageSize(page, 'table-library', 20);
  check('切到每页 20 条后行数不对', (await rowCount(page, 'table-library')) === 20);
  await setPageSize(page, 'table-library', 100);
  check('切到每页 100 条后行数不对', (await rowCount(page, 'table-library')) === 100);

  const narrowed = await searchTable(page, 'table-library', '滴滴');
  check('发票库搜索没有收窄结果', narrowed > 0 && narrowed < 100, `实际 ${narrowed} 行`);
  const matched = await tableRows(page, 'table-library').allInnerTexts();
  check(
    '发票库搜索命中了不含关键词的行',
    matched.every((text) => text.includes('滴滴')),
  );
  await searchTable(page, 'table-library', '');
}

async function checkInboxTable(page) {
  await gotoRoute(page, 'inbox');
  const total = await rowCount(page, 'table-inbox');
  check('邮件记录首屏应有 50 行', total === 50, `实际 ${total}`);

  await clickChip(page, 'table-inbox', '待确认');
  const pendingOnly = await tableRows(page, 'table-inbox').allInnerTexts();
  check('「待确认」筛选没有行', pendingOnly.length > 0);
  check(
    '「待确认」筛选混进了别的状态',
    pendingOnly.every((text) => text.includes('待确认')),
  );
  await clickChip(page, 'table-inbox', '全部');

  const narrowed = await searchTable(page, 'table-inbox', '铁路');
  check('邮件记录搜索没有收窄结果', narrowed > 0 && narrowed < 50, `实际 ${narrowed} 行`);
  await searchTable(page, 'table-inbox', '');
}

async function checkPendingTable(page) {
  await gotoRoute(page, 'pending');
  const total = await rowCount(page, 'table-pending');
  check('待确认队列没有数据', total > 0, `实际 ${total}`);

  const chips = await chipLabels(page, 'table-pending');
  check('待确认没有按分组给出筛选项', chips.length >= 3, chips.join('/'));

  await clickChip(page, 'table-pending', '链接已失效');
  const grouped = await tableRows(page, 'table-pending').allInnerTexts();
  check('「链接已失效」筛选没有行', grouped.length > 0);
  check(
    '「链接已失效」筛选混进了别的分组',
    grouped.every((text) => text.includes('链接已失效')),
    grouped[0]?.slice(0, 60),
  );
  check('分组筛选后行数应少于全部', grouped.length < total, `${grouped.length} / ${total}`);
  await clickChip(page, 'table-pending', '全部');
}

async function checkTables(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl);
  await checkLibraryTable(page);
  await checkInboxTable(page);
  await checkPendingTable(page);
  await assertClean(page, problems, '列表页');
  await page.close();
}

/* ---------------------------------------------------------------------------
 * 4. Drawers
 * ------------------------------------------------------------------------ */

/** Drawers render a spinner first; wait for the section that proves the fetch landed. */
async function waitForDrawer(page, testid, needle) {
  await tid(page, testid).waitFor({ state: 'visible', timeout: 10000 });
  await page
    .waitForFunction(
      ({ sel, text }) => document.querySelector(`[data-testid="${sel}"]`)?.innerText.includes(text),
      { sel: testid, text: needle },
      { timeout: 10000 },
    )
    .catch(() => fail(`${testid} 抽屉里一直没有出现「${needle}」`));
}

async function checkDrawers(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl, { route: 'library' });

  await openRow(page, 'table-library', 0);
  await waitForDrawer(page, 'drawer-invoice', '识别结果');
  const invoice = await tid(page, 'drawer-invoice').innerText();
  for (const label of ['识别结果', '开票日期', '销售方', '识别引擎', '来源', '文件']) {
    check(`发票详情抽屉缺少「${label}」`, invoice.includes(label));
  }
  check('发票详情没有可执行的主操作', await page.getByRole('button', { name: '打开文件' }).isVisible());
  await closeDrawer(page);

  await gotoRoute(page, 'inbox');
  await openRow(page, 'table-inbox', 0);
  await waitForDrawer(page, 'drawer-mail', '发件人');
  const mail = await tid(page, 'drawer-mail').innerText();
  check('邮件详情抽屉缺少发件人', mail.includes('发件人'));
  check('邮件详情抽屉缺少邮箱文件夹', mail.includes('邮箱文件夹'));
  await closeDrawer(page);

  await gotoRoute(page, 'pending');
  await openRow(page, 'table-pending', 0);
  await waitForDrawer(page, 'drawer-pending', '附件');
  const pending = await tid(page, 'drawer-pending').innerText();
  check('待确认抽屉没有先说清原因', /链接失效|手动归档|网络中断|需要人工确认/.test(pending), pending.slice(0, 80));
  check('待确认抽屉缺少证据区', pending.includes('附件') && pending.includes('链接'));
  await closeDrawer(page);

  await assertClean(page, problems, '详情抽屉');
  await page.close();
}

/* ---------------------------------------------------------------------------
 * 5. 清理重复 / 导出 CSV
 * ------------------------------------------------------------------------ */

async function checkLibraryActions(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl, { route: 'library' });

  await tid(page, 'action-dedupe').click();
  await tid(page, 'dedupe-report').waitFor({ state: 'visible', timeout: 20000 });
  const report = await tid(page, 'dedupe-report').innerText();
  check('清理重复的试算报告没有说明可移出多少份', /可移出 \d+ 份/.test(report), report.slice(0, 120));
  check('试算报告没有列出保留与移除', report.includes('保留') && report.includes('移除'));
  check('金额不一致的分组没有标成需要人工核对', report.includes('需要人工核对'), report.slice(0, 200));
  const groups = await rowCount(page, 'table-dedupe');
  check('试算报告没有分组行', groups > 0);

  await tid(page, 'action-dedupe-apply').click();
  await waitForToast(page, '已隔离');
  await page.locator('.ant-modal-content').first().waitFor({ state: 'hidden', timeout: 15000 });
  checks += 2;
  await dismissToasts(page);

  // 预览模式没有系统保存框：导出 CSV 必须给出回执，不能静默无事发生。
  await tid(page, 'action-export-csv').click();
  await page.waitForTimeout(800);
  checks++;

  await assertClean(page, problems, '发票库操作');
  await page.close();
}

/* ---------------------------------------------------------------------------
 * 6. Dark mode / empty / broken
 * ------------------------------------------------------------------------ */

async function checkDarkMode(browser, baseUrl) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark', locale: 'zh-CN' });
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl);
  const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const groundRgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(ground);
  check('深色模式下页面底色没有变暗', Boolean(groundRgb) && Number(groundRgb[1]) < 60, ground);
  const color = await page.evaluate(
    () => getComputedStyle(document.querySelector('.mfh-pageheader__title')).color,
  );
  const textRgb = /rgba?\((\d+), (\d+), (\d+)/.exec(color);
  check('深色模式下标题没有变亮', Boolean(textRgb) && Number(textRgb[1]) > 180, color);
  await gotoRoute(page, 'library');
  check('深色模式下发票库没有渲染出行', (await rowCount(page, 'table-library')) > 0);
  await assertClean(page, problems, '深色模式');
  await context.close();
}

async function checkEmptyState(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl, { variant: 'empty' });
  await expectVisibleText(page, '本次运行还没有新邮件');
  await expectVisibleText(page, '还没有运行记录');

  await gotoRoute(page, 'inbox');
  await expectVisibleText(page, '还没有邮件记录');
  await expectVisibleText(page, '去处理');

  await gotoRoute(page, 'library');
  await expectVisibleText(page, '还没有归档的发票');

  await gotoRoute(page, 'pending');
  await expectVisibleText(page, '没有需要确认的邮件');
  checks += 6;

  await assertClean(page, problems, '空状态');
  await page.close();
}

async function checkBrokenConfig(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl, { variant: 'broken', route: 'settings' });
  await tid(page, 'config-error').waitFor({ state: 'visible', timeout: 10000 });
  const alert = await tid(page, 'config-error').innerText();
  check('配置损坏时没有说清原因', alert.includes('配置文件无法读取'), alert.slice(0, 80));
  check('配置损坏时没有给出修复入口', alert.includes('修复配置'), alert.slice(0, 120));
  check('配置损坏时表单没有锁住', await page.getByLabel('服务器').isDisabled());

  await assertClean(page, problems, '配置损坏');
  await page.close();
}

/* ---------------------------------------------------------------------------
 * 7. Copy lint on every route
 * ------------------------------------------------------------------------ */

async function checkCopy(context, baseUrl) {
  const { page, problems } = await newPage(context);
  await openApp(page, baseUrl);
  const hits = [];
  for (const route of ROUTES) {
    await gotoRoute(page, route.key);
    hits.push(...(await lintVisibleCopy(page, route.title)));
    checks++;
  }

  // 抽屉和弹窗里的文案也算界面文案。
  await gotoRoute(page, 'library');
  await openRow(page, 'table-library', 0);
  await waitForDrawer(page, 'drawer-invoice', '识别结果');
  hits.push(...(await lintVisibleCopy(page, '发票详情')));
  await closeDrawer(page);
  await tid(page, 'action-dedupe').click();
  await tid(page, 'dedupe-report').waitFor({ state: 'visible', timeout: 20000 });
  hits.push(...(await lintVisibleCopy(page, '清理重复')));
  checks += 2;

  check('界面文案未通过检查', hits.length === 0, `\n  - ${hits.join('\n  - ')}`);
  await assertClean(page, problems, '文案检查');
  await page.close();
}

/* ------------------------------------------------------------------------ */

async function main() {
  assertRendererBuilt();

  await withCleanup(async (scope) => {
    const { baseUrl } = await scope.use(
      '静态服务器',
      () => startStaticServer(),
      ({ server }) => closeServer(server),
      { timeoutMs: 15000 },
    );

    const browser = await scope.use(
      'Chromium',
      () => chromium.launch({ timeout: LAUNCH_TIMEOUT_MS }),
      (launched) => launched.close(),
      { timeoutMs: LAUNCH_TIMEOUT_MS + 10000 },
    );

    const context = await scope.use(
      '浏览器上下文',
      () => browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN', colorScheme: 'light' }),
      (ctx) => ctx.close(),
      { timeoutMs: 20000 },
    );

    await checkShell(context, baseUrl);
    await checkRunFlow(context, baseUrl);
    await checkTables(context, baseUrl);
    await checkDrawers(context, baseUrl);
    await checkLibraryActions(context, baseUrl);
    await checkEmptyState(context, baseUrl);
    await checkBrokenConfig(context, baseUrl);
    await checkCopy(context, baseUrl);
    await checkDarkMode(browser, baseUrl);

    console.log(`浏览器套件断言数：${checks}`);
  });
}

await runSuite('Renderer browser E2E', main, { timeoutMs: 5 * 60 * 1000 });
