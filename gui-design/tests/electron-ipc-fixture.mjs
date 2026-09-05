/* Electron renderer + IPC fixture.
 *
 * WHAT THIS COVERS: the real Electron main process, the real preload bridge,
 * the real IPC handlers and the real renderer, driven end to end through the
 * new React UI — operation mutex, progress events, dedupe report parsing,
 * pending actions, detail handlers, config round-trip and IPC sanitisation.
 *
 * WHAT THIS DOES **NOT** COVER: the CLI. It runs with MFH_E2E_FAKE_CLI=1, so
 * `runCli()` is replaced by src/electron/devFakeBackend.ts — no mail is
 * fetched, nothing is downloaded or OCR'd. Real pipeline coverage lives in
 * gui-design/tests/cli-integration.mjs.
 *
 * The clock is frozen (page.clock.setFixedTime) so the date range the UI hands
 * the backend can be asserted exactly instead of rotting on the next calendar
 * day.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertFreshBuild, fail, runSuite, useTempDir, withCleanup } from './_shared.mjs';
import {
  clickChip,
  cspViolations,
  dismissToasts,
  firstAppWindow,
  gotoRoute,
  installUiProbe,
  launchElectronApp,
  openRow,
  pageTitle,
  readUiProbe,
  resetUiProbe,
  rowCount,
  seedDataDir,
  tableRows,
  tid,
} from './ui-helpers.mjs';

/* A fixed local instant. Every date the UI derives from "now" is recomputed
   here with the same algorithm the renderer uses. */
const FIXED_NOW = new Date('2026-05-21T10:00:00');

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 首页默认落在「近 30 天」：今天往回数 29 天。 */
const EXPECTED_FROM = ymd(new Date(FIXED_NOW.getTime() - 29 * 86400000));
const EXPECTED_TO = ymd(FIXED_NOW);

let checks = 0;
function check(label, condition, detail = '') {
  checks++;
  if (!condition) fail(`${label}${detail ? `：${detail}` : ''}`);
}

function expectShape(label, value, predicate) {
  check(label, predicate(value), JSON.stringify(value));
}

async function waitForLog(page, needle, timeout = 30000) {
  await page
    .waitForFunction(
      (text) => document.querySelector('[data-testid="log-console"]')?.innerText.includes(text),
      needle,
      { timeout },
    )
    .catch(() => fail(`运行日志里没有出现「${needle}」`));
  checks++;
}

async function waitForIdle(page, timeout = 60000) {
  await page
    .waitForFunction(
      () => {
        const button = document.querySelector('[data-testid="action-run-start"]');
        return Boolean(button) && !button.disabled;
      },
      undefined,
      { timeout },
    )
    .catch(() => fail('运行一直没有结束（「开始处理」始终置灰）'));
}

/* ---------------------------------------------------------------------------
 * 1. Dashboard: dry run, real run, progress, mutex
 * ------------------------------------------------------------------------ */

/** 长任务终态带回的 summary 走后端默认行数；界面必须再按完整查询拉一次。 */
async function expectFullSummaryReload(page, where) {
  await page
    .waitForFunction(
      () => window.__mfhLastSummaryQuery?.inboxLimit === 100000 && window.__mfhLastSummaryQuery?.libraryLimit === 100000,
      undefined,
      { timeout: 20000 },
    )
    .catch(() => fail(`${where}之后没有按完整查询重新拉取汇总`));
  checks++;
}

function forgetSummaryQuery(page) {
  return page.evaluate(() => {
    window.__mfhLastSummaryQuery = null;
  });
}

async function checkDryRun(page, config) {
  await tid(page, 'toggle-dry-run').click();
  check('试运行开关没有打开', (await tid(page, 'toggle-dry-run').getAttribute('aria-checked')) === 'true');
  await resetUiProbe(page);
  await forgetSummaryQuery(page);
  await tid(page, 'action-run-start').click();
  await waitForLog(page, '预览完成');
  await waitForIdle(page);
  // 试运行以前是直接 return 的，截断过的那份 summary 会一直留在 store 里。
  await expectFullSummaryReload(page, '试运行');

  const args = await page.evaluate(() => window.__mfhLastFetchArgs || []);
  check('勾选试运行后应传 --dry-run', args.includes('--dry-run'), JSON.stringify(args));

  // 预览不得写盘：邮件缓存目录必须还是空的。
  check('试运行不应写入邮件索引', !existsSync(join(config.paths.samples, 'INDEX.csv')));
  const cached = await readdir(config.paths.samples);
  check('试运行不应在邮件缓存目录留下文件', cached.length === 0, JSON.stringify(cached));
  const batch = await rowCount(page, 'table-batch');
  check('试运行不应回填「本次结果」', batch === 0, `实际 ${batch} 行`);

  await tid(page, 'toggle-dry-run').click();
  check('试运行开关没有关掉', (await tid(page, 'toggle-dry-run').getAttribute('aria-checked')) === 'false');
  await dismissToasts(page);
}

async function checkRealRun(page, config) {
  await resetUiProbe(page);
  await forgetSummaryQuery(page);
  await tid(page, 'action-run-start').click();

  // 三段任务的进度事件都要落进同一个日志面板。
  await waitForLog(page, '已保存 2 封新邮件');
  await waitForLog(page, '处理完成');
  await waitForLog(page, '识别完成');
  await waitForIdle(page);

  const probe = await readUiProbe(page);
  check('运行期间没有出现顶部运行提示条', probe.banner === true);
  check('运行结束没有给出完成提示', probe.toasts.length > 0, JSON.stringify(probe.toasts));

  const args = await page.evaluate(() => window.__mfhLastFetchArgs || []);
  const outIndex = args.indexOf('--out');
  check('获取邮件没有写入配置的邮件缓存目录', args[outIndex + 1] === config.paths.samples, JSON.stringify(args));
  check(
    '传给后端的日期窗口与界面不一致',
    args[args.indexOf('--since') + 1] === EXPECTED_FROM && args[args.indexOf('--until') + 1] === EXPECTED_TO,
    JSON.stringify(args),
  );
  const ocrArgs = await page.evaluate(() => window.__mfhLastOcrArgs || []);
  check(
    'Electron 侧识别应逐张续跑（--single-item，不带并发/强制）',
    ocrArgs.includes('--single-item') && !ocrArgs.includes('--concurrency') && !ocrArgs.includes('--force'),
    JSON.stringify(ocrArgs),
  );

  const batch = await rowCount(page, 'table-batch');
  check('「本次结果」应回填本次运行的 2 封邮件', batch === 2, `实际 ${batch} 行`);
  const batchText = (await tableRows(page, 'table-batch').allInnerTexts()).join('\n');
  check('「本次结果」里没有本次抓到的邮件', batchText.includes('国家电网电子发票通知'), batchText.slice(0, 120));

  const stats = await page.locator('.mfh-stat__value').allInnerTexts();
  check('运行后统计卡没有更新', stats[0]?.trim() === '2', stats.join('/'));

  const archived = await readdir(config.paths.invoices);
  check('归档目录里没有按顺序命名的发票', archived.includes('0001.pdf') && archived.includes('0002.pdf'), JSON.stringify(archived));

  await expectFullSummaryReload(page, '一次完整运行');
  await dismissToasts(page);
}

/**
 * 长任务在主进程是互斥的：抢跑的那个必须拿到一条结构化的 operation_busy，
 * 而不是静默排队。假后端用 MFH_E2E_FAKE_CLI_HOLD_MS 停住一段时间，
 * 这条契约才观察得到。
 */
async function checkMutex(page) {
  const outcome = await page.evaluate(async () => {
    const first = window.mfhBridge.runPipeline({});
    await new Promise((r) => setTimeout(r, 150));
    const running = await window.mfhBridge.getOpState();
    const second = await window.mfhBridge.runOcr({});
    return { running, second, first: await first };
  });

  expectShape('运行期间 op-state 应报告正在跑的任务', outcome.running, (r) => r?.running?.kind === 'pipeline'
    && typeof r.running.jobId === 'string' && typeof r.running.startedAt === 'number');
  expectShape('抢跑的第二个长任务没有被互斥挡下', outcome.second, (r) => r?.ok === false && r?.code === 'operation_busy');
  check('被挡下的任务不应声称已启动', outcome.second?.started !== true, JSON.stringify(outcome.second));
  check(
    '被挡下的任务应给出面向用户的中文说明',
    typeof outcome.second?.message === 'string' && outcome.second.message.length > 0 && !/[A-Za-z]{6,}/.test(outcome.second.message),
    JSON.stringify(outcome.second),
  );
  check('抢到锁的任务应正常结束', outcome.first?.ok === true, JSON.stringify(outcome.first?.code));

  const idle = await page.evaluate(() => window.mfhBridge.getOpState());
  check('任务结束后 op-state 应回到空闲', idle?.running === null, JSON.stringify(idle));

  // 没有识别任务时请求停止，必须给出明确回执而不是假装停了。
  const stop = await page.evaluate(() => window.mfhBridge.stopOcr());
  expectShape('空闲时的停止请求没有被拒绝', stop, (r) => r?.ok === false && typeof r?.code === 'string');
  await dismissToasts(page);
}

/* ---------------------------------------------------------------------------
 * 2. Library: rows, detail drawer, dedupe
 * ------------------------------------------------------------------------ */

async function checkLibrary(page) {
  await gotoRoute(page, 'library');
  await page
    .waitForFunction(() => document.querySelectorAll('[data-testid="table-library"] .ant-table-row').length > 0, undefined, { timeout: 15000 })
    .catch(() => fail('发票库没有渲染出归档记录'));
  checks++;

  const rows = (await tableRows(page, 'table-library').allInnerTexts()).join('\n');
  check('发票库没有显示识别出来的销售方', rows.includes('国家电网有限公司'), rows.slice(0, 200));
  check('发票库没有显示识别出来的金额', rows.includes('318.42'), rows.slice(0, 200));

  // 附属材料默认藏起来，切到「附属材料」才看得到。
  check('默认筛选不应显示附属材料', !rows.includes('附属材料'));
  await clickChip(page, 'table-library', '附属材料');
  const supporting = (await tableRows(page, 'table-library').allInnerTexts()).join('\n');
  check('「附属材料」筛选看不到通行费汇总单', supporting.includes('通行费电子票据汇总单'), supporting.slice(0, 200));
  await clickChip(page, 'table-library', '仅发票');

  await openRow(page, 'table-library', 0);
  await page
    .waitForFunction(
      () => document.querySelector('[data-testid="drawer-invoice"]')?.innerText.includes('识别结果'),
      undefined,
      { timeout: 15000 },
    )
    .catch(() => fail('发票详情抽屉没有渲染出识别结果'));
  const drawer = await tid(page, 'drawer-invoice').innerText();
  for (const needle of ['识别结果', '开票日期', '销售方', '识别引擎', '来源', '邮件主题', '文件名', '文件状态']) {
    check(`发票详情抽屉缺少「${needle}」`, drawer.includes(needle), drawer.slice(0, 200));
  }
  check('发票详情没有带出识别到的销售方', drawer.includes('国家电网有限公司'), drawer.slice(0, 200));
  check('发票详情没有把识别引擎翻成中文', /本机引擎|文本解析|图像识别|—/.test(drawer), drawer.slice(0, 400));
  check('发票详情里的文件名不对', drawer.includes('0001.pdf'), drawer.slice(0, 400));
  await page.locator('.ant-drawer-close').first().click();
  await page.locator('.ant-drawer-content').first().waitFor({ state: 'hidden', timeout: 8000 });
}

async function checkDedupe(page) {
  await tid(page, 'action-dedupe').click();
  await tid(page, 'dedupe-report').waitFor({ state: 'visible', timeout: 30000 });
  const report = await tid(page, 'dedupe-report').innerText();
  check('试算报告没有说明可移出多少份', /可移出 1 份/.test(report), report.slice(0, 160));
  const groups = await rowCount(page, 'table-dedupe');
  check('试算报告没有列出重复分组', groups === 1, `实际 ${groups} 组`);
  check('试算报告没有列出保留下来的文件', report.includes('0001.pdf'), report.slice(0, 200));

  // 试算阶段不得动文件。
  check('试算阶段不应产生隔离目录', !report.includes('已隔离'), report.slice(0, 160));

  await resetUiProbe(page);
  await tid(page, 'action-dedupe-apply').click();
  await page.locator('.ant-modal-content').first().waitFor({ state: 'hidden', timeout: 30000 });
  const probe = await readUiProbe(page);
  check('确认清理后没有给出回执', probe.toasts.length > 0, JSON.stringify(probe.toasts));

  // 主进程侧的报文形状：无效选项必须被直接拒绝，不能落到 CLI。
  for (const payload of [{}, { by: 'invalid', apply: false }, { by: 'container', apply: 'false' }]) {
    const result = await page.evaluate((value) => window.mfhBridge.dedupe(value), payload);
    expectShape('非法的清理选项没有被拒绝', result, (r) => r?.ok === false && r?.code === 'invalid_dedupe_options');
  }
  const applied = await page.evaluate(() => window.mfhBridge.dedupe({ by: 'invoice-no', apply: true }));
  expectShape('apply 的报告没有回填隔离数量', applied, (r) => r?.report?.applied === true && r?.report?.quarantined === 1);
  expectShape(
    '隔离目录必须投影成数据目录内的相对路径',
    applied,
    (r) => typeof r?.report?.quarantineDir === 'string' && !r.report.quarantineDir.startsWith('/'),
  );
  await dismissToasts(page);
}

/* ---------------------------------------------------------------------------
 * 3. Pending + inbox deep link
 * ------------------------------------------------------------------------ */

async function checkPending(page) {
  await gotoRoute(page, 'pending');
  await page
    .waitForFunction(() => document.querySelectorAll('[data-testid="table-pending"] .ant-table-row').length > 0, undefined, { timeout: 15000 })
    .catch(() => fail('待确认队列没有渲染出行'));
  checks++;
  const rows = (await tableRows(page, 'table-pending').allInnerTexts()).join('\n');
  check('待确认队列没有显示那封链接失效的邮件', rows.includes('发票下载链接已过期'), rows.slice(0, 200));

  // 行尾的「打开邮件」：无论落到哪条分支，都必须给用户一个明确回执。
  await resetUiProbe(page);
  await page.getByRole('button', { name: '打开邮件' }).first().click();
  await page.waitForTimeout(1200);
  const probe = await readUiProbe(page);
  check('「打开邮件」没有给出任何回执', probe.toasts.length > 0, JSON.stringify(probe.toasts));

  const hash = await page.evaluate(async () => {
    const summary = await window.mfhBridge.getSummary({ inboxLimit: 50, libraryLimit: 50 });
    return summary?.pending?.groups?.[0]?.rows?.[0]?.hash ?? '';
  });
  check('摘要里的待确认行缺少邮件标识', /^[0-9a-f]{12,64}$/.test(hash), hash);

  const opened = await page.evaluate((value) => window.mfhBridge.openMail({ hash: value }), hash);
  expectShape(
    '打开待确认邮件的结果必须说清究竟打开了什么',
    opened,
    (r) => /^(mail|folder|reveal_attempted|none)$/.test(r?.opened ?? '') && typeof r?.code === 'string',
  );
  for (const payload of [{}, { hash: 'f'.repeat(32) }, { hash: '../outside' }]) {
    const result = await page.evaluate((value) => window.mfhBridge.openMail(value), payload);
    expectShape('未知/非法邮件必须被拒绝', result, (r) => r?.ok === false && r?.opened === 'none');
  }

  /* 「全部重试」与单封重试是互斥的输入源：同时给出必须明确拒绝，
     静默降级成单封会让用户以为整队跑过了。 */
  const conflicting = await page.evaluate(() =>
    window.mfhBridge.runPipeline({ pendingRetry: true, onlyMail: 'a'.repeat(32) }),
  );
  expectShape('pendingRetry + onlyMail 必须被拒绝', conflicting, (r) => r?.ok === false && r?.code === 'invalid_pending_retry');

  /* 行尾的单封重试必须真的把这封邮件送进管线。之前它同时传 pendingRetry，
     每次点击都只换回一条 invalid_pending_retry，而上面那条契约断言看不出来。 */
  await page.evaluate(() => {
    window.__mfhLastPipelineArgs = null;
  });
  await forgetSummaryQuery(page);
  await resetUiProbe(page);
  await page.getByRole('button', { name: '重试', exact: true }).first().click();
  await page
    .waitForFunction(() => Array.isArray(window.__mfhLastPipelineArgs), undefined, { timeout: 30000 })
    .catch(() => fail('点击单封重试后管线没有启动'));
  checks++;
  const retryArgs = await page.evaluate(() => window.__mfhLastPipelineArgs);
  check('单封重试没有走 run，而是当成了「全部重试」', retryArgs[0] === 'run' && !retryArgs.includes('retry'), JSON.stringify(retryArgs));
  check(
    '单封重试没有把这封邮件的标识传给后端',
    retryArgs[retryArgs.indexOf('--only-mail') + 1] === hash,
    JSON.stringify(retryArgs),
  );
  await expectFullSummaryReload(page, '单封重试');
  const retryProbe = await readUiProbe(page);
  check('单封重试没有给出回执', retryProbe.toasts.length > 0, JSON.stringify(retryProbe.toasts));
  check(
    '单封重试撞上了互斥输入的拒绝',
    !retryProbe.toasts.some((text) => text.includes('不能和单封重试一起使用')),
    JSON.stringify(retryProbe.toasts),
  );

  const retryAll = tid(page, 'action-pending-retry-all');
  check('待确认页缺少「全部重试」入口', (await retryAll.count()) === 1);
  await dismissToasts(page);
}

/** 发票库的「查看邮件」跳到 #/inbox/<hash>：数据到了就把那封邮件的抽屉打开。 */
async function checkInboxDeepLink(page) {
  await gotoRoute(page, 'inbox');
  const hash = await page.evaluate(async () => {
    const summary = await window.mfhBridge.getSummary({ inboxLimit: 50, libraryLimit: 50 });
    return summary?.inbox?.rows?.[0]?.mailHash ?? '';
  });
  check('摘要里的邮件缺少标识', /^[0-9a-f]{12,64}$/.test(hash), hash);

  await page.evaluate((target) => {
    window.location.hash = `#/inbox/${target}`;
  }, hash);
  await page
    .waitForFunction(() => document.querySelector('[data-testid="drawer-mail"]'), undefined, { timeout: 15000 })
    .catch(() => fail('深链 #/inbox/<hash> 没有打开邮件详情抽屉'));
  checks++;
  const drawer = await tid(page, 'drawer-mail').innerText();
  check('深链打开的抽屉里没有邮件信息', drawer.includes('发件人'), drawer.slice(0, 160));
  check('深链后页面标题应还是邮件记录', (await pageTitle(page)) === '邮件记录');

  await page.locator('.ant-drawer-close').first().click();
  await page.locator('.ant-drawer-content').first().waitFor({ state: 'hidden', timeout: 8000 });
  // 关掉抽屉后 hash 要退回列表，否则同一封邮件再也点不开第二次。
  check('关掉深链抽屉后 hash 没有退回列表', page.url().endsWith('#/inbox'), page.url());
}

/* ---------------------------------------------------------------------------
 * 4. Settings round-trip
 * ------------------------------------------------------------------------ */

async function checkSettings(page, configPath) {
  await gotoRoute(page, 'settings');
  const host = page.getByLabel('服务器');
  await host.waitFor({ state: 'visible', timeout: 15000 });
  check('保存按钮在没有改动时应置灰', await tid(page, 'action-settings-save').isDisabled());

  await host.fill('imap.roundtrip.local');
  await page
    .waitForFunction(() => document.body.innerText.includes('有未保存的修改'), undefined, { timeout: 8000 })
    .catch(() => fail('改动之后没有提示「有未保存的修改」'));
  checks++;
  check('有改动时保存按钮应可用', !(await tid(page, 'action-settings-save').isDisabled()));

  await resetUiProbe(page);
  await tid(page, 'action-settings-save').click();
  await page
    .waitForFunction(() => !document.body.innerText.includes('有未保存的修改'), undefined, { timeout: 15000 })
    .catch(() => fail('保存之后「有未保存的修改」没有消失'));
  checks++;

  const reread = await page.evaluate(() => window.mfhBridge.getConfig());
  check('保存后重新读取的配置没有反映改动', reread?.config?.imap?.host === 'imap.roundtrip.local', JSON.stringify(reread?.config?.imap));
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  check('改动没有落到 config.json', onDisk.imap.host === 'imap.roundtrip.local', JSON.stringify(onDisk.imap));
  // 只提交改过的字段：整份回写会把脱敏过的展示串当成真路径写回去。
  check('保存不应抹掉已存的授权码', typeof onDisk.imap.pass === 'string' && onDisk.imap.pass.length > 0, JSON.stringify(onDisk.imap.pass));
  check('保存不应改写归档目录', onDisk.paths.invoices.includes('invoices'), onDisk.paths.invoices);

  await dismissToasts(page);
}

/* ---------------------------------------------------------------------------
 * 5. IPC sanitisation: no raw subprocess output, no raw paths
 * ------------------------------------------------------------------------ */

async function checkSanitisation(page, config) {
  const shape = await page.evaluate(async () => {
    const result = await window.mfhBridge.organize({ applyRename: false });
    return { keys: Object.keys(result), code: result.code, exitCode: result.exitCode, message: result.message };
  });
  check('IPC 返回值仍携带原始子进程输出', !shape.keys.includes('stdout') && !shape.keys.includes('stderr'), JSON.stringify(shape.keys));
  check('IPC 返回的 code 应是结构化字符串', /^organize_(done|failed|partial)$/.test(shape.code ?? ''), String(shape.code));
  check('IPC 返回值缺少数字 exitCode', typeof shape.exitCode === 'number', String(shape.exitCode));
  check('IPC message 应是面向用户的中文文案', Boolean(shape.message) && !/[A-Za-z]{6,}/.test(shape.message), String(shape.message));
  await dismissToasts(page);

  // 归档事务留下无法证明归属的残留时，整理必须 fail-closed 并且不泄露真实路径。
  const journalDir = join(config.paths.invoices, '.journal');
  const journalPath = join(journalDir, 'electron-organize-blocked.json');
  const unproven = join(config.paths.invoices, '0099.pdf');
  await mkdir(journalDir, { recursive: true });
  await writeFile(unproven, '%PDF-1.4\n%UNPROVEN\n%EOF\n');
  await writeFile(
    journalPath,
    `${JSON.stringify({
      txId: 'electron-organize-blocked',
      pid: 99999999,
      startedAtMs: Date.now(),
      stage: 'prepared',
      files: [unproven],
      csv: [
        { path: config.output.csv, baseLength: 0 },
        { path: join(config.paths.invoices, 'ocr', 'ocr-pending.csv'), baseLength: 0 },
      ],
    })}\n`,
  );
  const blocked = await page.evaluate(() => window.mfhBridge.organize({ applyRename: false }));
  expectShape('残留归档记录必须挡住整理', blocked, (r) => r?.ok === false && r?.code === 'archive_recovery_blocked');
  check(
    '被挡下的整理泄露了原始子进程字段',
    !Object.prototype.hasOwnProperty.call(blocked, 'stdout') && !Object.prototype.hasOwnProperty.call(blocked, 'stderr'),
    JSON.stringify(Object.keys(blocked)),
  );
  const text = `${blocked.message ?? ''}\n${blocked.detail ?? ''}`;
  check('被挡下的整理泄露了真实归档路径', !text.includes(config.paths.invoices), text);

  await rm(journalPath, { force: true });
  await rm(unproven, { force: true });
  await rm(journalDir, { recursive: true, force: true });
  await dismissToasts(page);
}

/**
 * 手动归档在写完队列 CSV 之后失败（注入的故障）时，回滚不完整必须映射成脱敏的
 * 「归档恢复被阻断」，而不是把内部错误名和真实路径摆给用户。
 */
async function checkManualArchiveRollback(page, config, source) {
  const hash = await page.evaluate(async () => {
    const summary = await window.mfhBridge.getSummary({ inboxLimit: 50, libraryLimit: 50 });
    return summary?.pending?.groups?.[0]?.rows?.[0]?.hash ?? '';
  });
  if (!hash) fail('待确认队列里没有可用于手动归档的邮件');

  const ledgerBefore = existsSync(config.output.csv) ? await readFile(config.output.csv, 'utf8') : undefined;
  const ocrPendingPath = join(config.paths.invoices, 'ocr', 'ocr-pending.csv');
  const ocrBefore = existsSync(ocrPendingPath) ? await readFile(ocrPendingPath, 'utf8') : undefined;

  const blocked = await page.evaluate((value) => window.mfhBridge.pendingManualArchive({ hash: value }), hash);
  expectShape('手动归档回滚失败应映射成归档恢复被阻断', blocked, (r) => r?.ok === false && r?.code === 'archive_recovery_blocked');
  check(
    '手动归档的失败回执泄露了原始子进程字段',
    !Object.prototype.hasOwnProperty.call(blocked, 'stdout') && !Object.prototype.hasOwnProperty.call(blocked, 'stderr'),
    JSON.stringify(Object.keys(blocked)),
  );
  const text = `${blocked.message ?? ''}\n${blocked.detail ?? ''}`;
  check(
    '手动归档的失败回执泄露了真实路径或内部错误名',
    !text.includes(config.paths.invoices) && !text.includes(source) && !text.includes('forced_after_manual_queue_csv_failure'),
    text,
  );

  if (ledgerBefore === undefined) await rm(config.output.csv, { force: true });
  else await writeFile(config.output.csv, ledgerBefore);
  if (ocrBefore === undefined) await rm(ocrPendingPath, { force: true });
  else await writeFile(ocrPendingPath, ocrBefore);
  await rm(join(config.paths.invoices, '.journal'), { recursive: true, force: true });
  await dismissToasts(page);
}

/* ---------------------------------------------------------------------------
 * 6. Detail handlers against real MIME + CSV data
 *
 * Runs last: it rewrites the ledger and OCR CSVs, so every list assertion above
 * would otherwise be reading data this function invented.
 * ------------------------------------------------------------------------ */

function csv(header, rows) {
  return `${[header, ...rows].map((row) => row.map((cell) => JSON.stringify(String(cell))).join(',')).join('\n')}\n`;
}

async function seedDetailFixture(config) {
  const hash = 'd'.repeat(32);
  const messageId = '<mfh-ipc-detail@example.com>';
  const filename = 'detail-invoice.pdf';
  const duplicateFilename = 'detail-copy.pdf';
  const invoiceNo = '12345678901234567890';
  const contentHash = '123456abcdef';
  const date = '2026-05-21T09:30:00.000Z';
  const from = 'Fixture <fixture@example.com>';
  const subject = 'Invoice detail fixture';
  const pdf = '%PDF-1.4\n% detail fixture\n';
  const invoiceUrl = 'https://invoice.example.com/download/invoice.pdf?token=short-token';
  const sourceUrl = `https://fixture-user:fixture-secret@invoice.example.com/invoice.pdf?token=${'s'.repeat(80)}&id=visible`;

  await mkdir(config.paths.samples, { recursive: true });
  await mkdir(config.paths.pending, { recursive: true });
  await mkdir(join(config.paths.invoices, 'ocr'), { recursive: true });
  await writeFile(
    join(config.paths.pending, `${hash}.eml`),
    [
      `Message-ID: ${messageId}`, 'Date: Thu, 21 May 2026 09:30:00 +0000',
      `From: ${from}`, 'To: receiver@example.com', `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="detail-boundary"', '',
      '--detail-boundary', 'Content-Type: text/html; charset=utf-8', '',
      `<html><body><a href="${invoiceUrl}">Download invoice</a></body></html>`,
      '--detail-boundary', 'Content-Type: application/pdf; name="detail-invoice.pdf"',
      'Content-Disposition: attachment; filename="detail-invoice.pdf"',
      'Content-Transfer-Encoding: base64', '', Buffer.from(pdf).toString('base64'),
      '--detail-boundary--', '',
    ].join('\r\n'),
  );
  await writeFile(
    join(config.paths.samples, 'INDEX.csv'),
    csv(['messageId', 'date', 'from', 'subject', 'mailbox', 'hasAttachment', 'bodyLinkCount', 'mailHash'],
      [[messageId, date, from, subject, 'INBOX', '1', '1', hash]]),
  );
  await writeFile(
    join(config.paths.pending, 'pending.csv'),
    csv(['messageId', 'date', 'from', 'subject', 'reason', 'mailHash'], [[messageId, date, from, subject, 'http_403', hash]]),
  );
  await writeFile(
    config.output.csv,
    csv(['messageId', 'date', 'from', 'subject', 'filename', 'source', 'contentHash', 'mailHash'], [
      [messageId, date, from, subject, filename, sourceUrl, contentHash, hash],
      ['<other@example.com>', date, from, 'Other mail', duplicateFilename, 'attachment', 'abcdef123456', 'e'.repeat(32)],
      [messageId, date, from, subject, '../manual-rollback-source.pdf', 'attachment', '', hash],
    ]),
  );
  const ocrHeader = ['hash', 'messageId', 'date', 'from', 'subject', 'filename', 'source', 'format',
    'documentType', 'invoiceType', 'seller', 'amount', 'dateValue', 'invoiceNo', 'transport',
    'extractedBy', 'parserVersion', 'ocrVendor', 'status', 'error', 'contentHash'];
  const recognized = [hash, messageId, date, from, subject, filename, sourceUrl, 'pdf',
    'invoice', '电子发票', 'Detail Seller', '123.45', '2026-05-21', invoiceNo, 'local',
    'pdf-text', 'fixture-v1', '', 'success', '', contentHash];
  // 后写的失败行不得覆盖已经成功的识别结果。
  const laterFailure = [...recognized];
  laterFailure[18] = 'failed';
  laterFailure[19] = 'later failure must not replace success';
  const duplicate = [...recognized];
  duplicate[0] = 'e'.repeat(32);
  duplicate[1] = '<other@example.com>';
  duplicate[5] = duplicateFilename;
  duplicate[20] = 'abcdef123456';
  await writeFile(config.ocr.resultsCsv, csv(ocrHeader, [recognized, laterFailure, duplicate]));
  await writeFile(join(config.paths.invoices, filename), pdf);
  await writeFile(join(config.paths.invoices, duplicateFilename), pdf);

  return { hash, messageId, filename, duplicateFilename, invoiceNo, contentHash, invoiceUrl, pdf };
}

async function checkDetailHandlers(page, config) {
  const fixture = await seedDetailFixture(config);
  const size = Buffer.byteLength(fixture.pdf);

  const detail = await page.evaluate((value) => window.mfhBridge.mailDetail({ hash: value }), fixture.hash);
  const mail = detail?.mail;
  expectShape(
    '邮件详情的元数据/状态不正确',
    detail,
    (r) => r?.ok === true && r.mail?.mailHash === fixture.hash && r.mail?.emlLocation === 'pending'
      && r.mail?.emlExists === true && r.mail?.status === 'archived' && r.mail?.messageId === fixture.messageId,
  );
  check(
    '邮件详情没有解析出 MIME 附件与正文链接',
    mail?.attachments?.some((row) => row.filename === fixture.filename && row.size === size && row.contentType === 'application/pdf')
      && mail?.links?.some((row) => row.url === fixture.invoiceUrl && typeof row.label === 'string'),
    JSON.stringify({ attachments: mail?.attachments, links: mail?.links }),
  );
  const document = mail?.documents?.find((row) => row.filename === fixture.filename);
  check(
    '邮件详情没有把台账、识别结果和可打开句柄拼起来',
    document?.seller === 'Detail Seller' && document?.invoiceNo === fixture.invoiceNo
      && document?.contentHash === fixture.contentHash && Boolean(document?.fileHandle),
    JSON.stringify(mail?.documents),
  );
  check(
    '邮件详情缺少待确认原因或处理记录',
    mail?.pending?.reason === 'http_403' && Boolean(mail?.pending?.category) && Boolean(mail?.pending?.userMessage)
      && Boolean(mail?.pending?.nextStep) && Array.isArray(mail?.history),
    JSON.stringify(mail?.pending),
  );
  const missing = await page.evaluate(() => window.mfhBridge.mailDetail({ hash: 'f'.repeat(32) }));
  expectShape('找不到的邮件必须被拒绝', missing, (r) => r?.ok === false && r?.code === 'mail_not_found');

  const invoiceResult = await page.evaluate((value) => window.mfhBridge.invoiceDetail({ filename: value }), fixture.filename);
  const invoice = invoiceResult?.invoice;
  expectShape(
    '发票详情的连接/成功优先/文件/重复信息不正确',
    invoiceResult,
    (r) => r?.ok === true && r.invoice?.row?.filename === fixture.filename && r.invoice?.ocr?.status === 'success'
      && r.invoice?.ocr?.parserVersion === 'fixture-v1' && r.invoice?.ledger?.mailHash === fixture.hash
      && r.invoice?.file?.exists === true && r.invoice?.file?.size === size && r.invoice?.file?.format === 'pdf'
      && r.invoice?.file?.handle === r.invoice?.row?.fileHandle
      && r.invoice?.duplicates?.length === 1 && r.invoice.duplicates[0]?.filename === fixture.duplicateFilename,
  );
  for (const source of [document.source, invoice.row.source, invoice.ledger.source]) {
    const url = new URL(source);
    check(
      '详情里的来源地址必须去掉账号密码并截断超长参数',
      !url.username && !url.password && !source.includes('s'.repeat(80)) && url.searchParams.get('id') === 'visible',
      source,
    );
  }
  for (const candidate of ['missing.pdf', '../manual-rollback-source.pdf', join(config.paths.pending, `${fixture.hash}.eml`)]) {
    const result = await page.evaluate((value) => window.mfhBridge.invoiceDetail({ filename: value }), candidate);
    expectShape('不存在或越界的文件必须被拒绝', result, (r) => r?.ok === false && r?.code === 'invoice_not_found');
  }
}

/* ------------------------------------------------------------------------ */

async function main() {
  await assertFreshBuild();

  await withCleanup(async (scope) => {
    const tmp = await useTempDir(scope, 'mfh-electron-ipc-');
    const seeded = await seedDataDir(tmp, (config) => {
      config.imap.host = 'imap.e2e.local';
      config.imap.user = 'e2e@example.com';
      config.imap.pass = 'e2e-password';
      config.filter.keywords = ['发票', '行程单'];
      config.ocr.ocrMode = 'auto';
    });
    const manualRollbackSource = join(tmp, 'manual-rollback-source.pdf');
    await writeFile(manualRollbackSource, '%PDF-1.4\n%MANUAL-ROLLBACK\n%EOF\n');

    const app = await launchElectronApp(scope, {
      ...seeded,
      env: {
        MFH_E2E_FAKE_CLI: '1',
        // 假后端是同步的；停住 400ms 才能观察到操作互斥与运行提示条。
        MFH_E2E_FAKE_CLI_HOLD_MS: '400',
        MFH_TEST_FAULT_TOKEN: 'mail-fapiao-helper-test-faults',
        MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE: '1',
        MFH_TEST_FAIL_AFTER_MANUAL_QUEUE_CSV: '1',
        MFH_TEST_FAIL_CSV_TRUNCATE: '1',
        MFH_TEST_MANUAL_ARCHIVE_SOURCES: manualRollbackSource,
      },
    });

    const { page, problems } = await firstAppWindow(app);
    await page.setViewportSize({ width: 1360, height: 900 });

    // 冻结 now，再重跑一次页面，首页的日期范围才是按固定时刻算出来的。
    await page.clock.setFixedTime(FIXED_NOW);
    await installUiProbe(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await tid(page, 'page-title').waitFor({ state: 'visible', timeout: 20000 });
    check('启动后应停在开始处理页', (await pageTitle(page)) === '开始处理');

    const bridgeReady = await page.evaluate(() => typeof window.mfhBridge?.startFetch === 'function'
      && typeof window.mfhBridge?.getOpState === 'function');
    check('Electron preload 桥接不可用', bridgeReady === true);

    await checkDryRun(page, seeded.config);
    await checkRealRun(page, seeded.config);
    await checkMutex(page);
    await checkLibrary(page);
    await checkDedupe(page);
    await checkPending(page);
    await checkInboxDeepLink(page);
    await checkSettings(page, seeded.configPath);
    await checkSanitisation(page, seeded.config);
    await checkManualArchiveRollback(page, seeded.config, manualRollbackSource);
    await checkDetailHandlers(page, seeded.config);

    const violations = await cspViolations(page);
    check('渲染层触发了 CSP 违规', violations.length === 0, violations.join('; '));
    check('渲染层输出了控制台错误', problems.length === 0, problems.join('; '));

    console.log(`Electron IPC fixture 断言数：${checks}`);
  });
}

await runSuite('Electron renderer/IPC fixture (fake CLI)', main, { timeoutMs: 5 * 60 * 1000 });
