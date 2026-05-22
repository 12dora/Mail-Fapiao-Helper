import { _electron as electron } from 'playwright';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fail(message) {
  throw new Error(message);
}

async function expectText(page, text, timeout = 8000) {
  await page.waitForFunction((needle) => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.body.querySelectorAll('*')).some((el) => visible(el) && el.textContent?.includes(needle));
  }, text, { timeout });
}

async function expectNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) fail(`${label} 存在横向溢出`);
}

async function expectToast(page, title) {
  await page.locator('.toast').getByText(title, { exact: false }).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function countRows(page, selector) {
  return page.locator(selector).evaluate((tbody) => Array.from(tbody.querySelectorAll('tr')).filter((tr) => !tr.textContent.includes('暂无')).length);
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-electron-full-'));
  const configPath = join(tmp, 'config.json');
  const statePath = join(tmp, 'state.json');
  const userDataPath = join(tmp, 'user-data');
  await copyFile('config.example.json', configPath);

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.imap.host = 'imap.e2e.local';
  config.imap.user = 'e2e@example.com';
  config.imap.pass = 'e2e-password';
  config.filter.keywords = ['发票', '行程单'];
  config.paths.samples = join(tmp, 'samples', 'raw');
  config.paths.invoices = join(tmp, 'invoices');
  config.paths.pending = join(tmp, 'pending');
  config.output.dir = join(tmp, 'invoices');
  config.output.pendingDir = join(tmp, 'pending');
  config.output.csv = join(tmp, 'invoices.csv');
  config.ocr.resultsCsv = join(tmp, 'invoices', 'ocr', 'ocr-results.csv');
  config.ocr.ocrMode = 'auto';
  config.rename.organizedDir = join(tmp, 'invoices', 'organized');
  config.playwright.browserManagement = 'app-managed';
  await mkdir(config.paths.samples, { recursive: true });
  await mkdir(config.paths.invoices, { recursive: true });
  await mkdir(config.paths.pending, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataPath}`],
    env: {
      ...process.env,
      MFH_CONFIG_PATH: configPath,
      MFH_STATE_PATH: statePath,
      MFH_E2E_FAKE_CLI: '1',
    },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1180, height: 780 });
    await page.waitForLoadState('domcontentloaded');
    await expectText(page, '运行控制台');
    await expectNoHorizontalOverflow(page, '运行控制台');

    const bridgeType = await page.evaluate(() => typeof window.mfhBridge?.startFetch);
    if (bridgeType !== 'function') fail('Electron preload bridge 不可用');

    await page.waitForURL(/dashboard\.html/);
    await expectText(page, '运行控制台');
    await expectText(page, '获取发票文件实时日志');
    await expectText(page, '识别发票文件实时日志');
    await expectText(page, '获取邮件实时日志');
    await expectText(page, '最多显示最近 6 条记录');
    await expectText(page, '已获取邮件');
    await expectNoHorizontalOverflow(page, '运行控制台');

    const initialProgress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (initialProgress !== '0%') fail(`初始进度应为 0%，实际为 ${initialProgress}`);
    const dashboardOrder = await page.evaluate(() => Array.from(document.querySelectorAll('.page h3')).map((el) => el.textContent.trim()).slice(0, 8));
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

    await page.getByRole('button', { name: '本周以来' }).click();
    await expectText(page, '2026-05-18 至 2026-05-21');
    await page.getByRole('button', { name: '查看将要执行的操作' }).click();
    await expectToast(page, '将要执行');

    await page.getByRole('button', { name: '开始获取邮件' }).click();
    await page.locator('#run-status').getByText('完成', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
    await expectText(page, '已保存 2 封新邮件');
    await expectText(page, '国家电网电子发票通知');
    const progress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (progress !== '100%') fail(`抓取后进度应为 100%，实际为 ${progress}`);
    const fetchArgs = await page.evaluate(() => window.__mfhLastFetchArgs || []);
    const outIndex = fetchArgs.indexOf('--out');
    if (outIndex < 0 || fetchArgs[outIndex + 1] !== config.paths.samples) {
      fail(`获取邮件没有写入配置的邮件缓存目录：${JSON.stringify(fetchArgs)}`);
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
    await page.getByRole('link', { name: /邮件记录/ }).click();
    await page.waitForURL(/inbox\.html/);
    await page.locator('main.main:not([style*="display: none"]) [data-inbox-rows]').getByText('国家电网电子发票通知', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('link', { name: '开始处理' }).click();
    await page.waitForURL(/dashboard\.html/);

    await page.getByRole('button', { name: '开始获取发票文件' }).click();
    await expectToast(page, '获取完成');
    await expectText(page, '获取完成：处理 2 封，跳过 0 封，失败 0 封。');
    await page.getByRole('button', { name: '打开文件位置' }).click();
    await expectToast(page, '已打开文件夹');
    const fileProgress = await page.locator('[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
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
    await page.getByRole('link', { name: /发票库/ }).click();
    await page.waitForURL(/library\.html/);
    await page.locator('[data-library-rows]').getByText('0001.pdf', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('link', { name: '开始处理' }).click();
    await page.waitForURL(/dashboard\.html/);
    await page.getByRole('button', { name: '开始识别发票文件' }).click();
    await expectToast(page, '识别完成');
    await expectText(page, '已扫描 3 个文件，识别成功 2 个');
    await expectText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。');
    const ocrProgress = await page.locator('main.main:not([style*="display: none"]) [data-ocr-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
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

    await page.getByRole('button', { name: '一键改名' }).first().click();
    await expectToast(page, '改名完成');
    await page.getByRole('button', { name: '复制日志' }).click();
    await expectToast(page, '已复制');

    await page.getByRole('link', { name: /邮件记录/ }).click();
    await page.waitForURL(/inbox\.html/);
    await page.getByRole('link', { name: '开始处理' }).click();
    await page.waitForURL(/dashboard\.html/);
    const preservedFileProgress = await page.locator('[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (preservedFileProgress !== '100%') fail(`页面切换后获取发票进度不应丢失，实际为 ${preservedFileProgress}`);
    await page.getByRole('link', { name: /邮件记录/ }).click();
    await page.waitForURL(/inbox\.html/);
    await expectText(page, '邮件记录');
    await page.locator('main.main:not([style*="display: none"]) [data-inbox-rows]').getByText('国家电网电子发票通知', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    await expectNoHorizontalOverflow(page, '邮件记录');
    await page.locator('[data-search="inbox"]').fill('国家电网');
    const filteredInboxRows = await countRows(page, '[data-inbox-rows]');
    if (filteredInboxRows !== 1) fail(`邮件搜索后应只剩 1 行，实际 ${filteredInboxRows}`);
    await page.locator('[data-filter="inbox-attachment"]').click();
    await page.locator('[data-filter="inbox-links"]').click();
    await page.getByRole('button', { name: '复制为 CSV' }).click();
    await expectToast(page, '已复制');
    await page.getByRole('button', { name: '打开邮件缓存' }).click();
    await expectToast(page, '已打开文件夹');

    await page.getByRole('link', { name: /发票库/ }).click();
    await page.waitForURL(/library\.html/);
    await page.locator('[data-library-rows]').getByText('国家电网有限公司', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-library-rows]').getByText('¥ 318.42', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    await expectNoHorizontalOverflow(page, '发票库');
    await page.locator('[data-search="library"]').fill('国家电网');
    const filteredLibraryRows = await countRows(page, '[data-library-rows]');
    if (filteredLibraryRows !== 1) fail(`发票库搜索后应只剩 1 行，实际 ${filteredLibraryRows}`);
    await page.getByRole('button', { name: '行程单' }).click();
    await expectText(page, '没有找到匹配结果');
    await page.locator('[data-search="library"]').fill('');
    await page.locator('[data-library-rows]').getByText('0002.pdf', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-library-rows]').getByRole('button', { name: '打开' }).first().click();
    await expectToast(page, '已打开文件位置');
    await page.getByRole('button', { name: '打开归档目录' }).click();
    await expectToast(page, '已打开文件夹');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '重新识别' }).click();
    await expectToast(page, '识别完成');
    await expectText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。');
    await page.getByRole('button', { name: '一键改名' }).click();
    await expectToast(page, '改名完成');

    await page.getByRole('link', { name: /待确认/ }).click();
    await page.waitForURL(/pending\.html/);
    await expectText(page, '下载失败或链接过期');
    await expectText(page, '发票下载链接已过期');
    await expectNoHorizontalOverflow(page, '待确认');
    await page.locator('[data-action="pending-primary"]').click();
    await expectToast(page, '需要重新授权');
    await page.getByRole('button', { name: '打开待确认文件夹' }).first().click();
    await expectToast(page, '已打开文件夹');
    await page.getByRole('button', { name: '复制原因' }).click();
    await expectToast(page, '已复制');
    await page.getByRole('button', { name: '复制为 CSV' }).click();
    await expectToast(page, '已复制');
    await page.getByRole('button', { name: '刷新列表' }).first().click();
    await expectToast(page, '已刷新');

    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(/config\.html/);
    await expectText(page, '配置');
    await expectNoHorizontalOverflow(page, '配置');
    await page.getByRole('button', { name: '测试邮箱连接' }).click();
    await expectToast(page, '邮箱连接正常');
    await expectText(page, '这里只设置要找什么内容');
    await expectText(page, '{seller}');
    await expectText(page, '{invoiceNo}');
    const modeHelp = await page.locator('body').evaluate((body) => body.innerText.includes('默认“规则优先，必要时调用 OCR”'));
    if (!modeHelp) fail('设置页缺少 efapiao 识别模式说明');
    await expectText(page, '当前版本不会调用 LLM');
    await expectText(page, '桌面版会随应用准备浏览器');
    const removedConfigText = await page.locator('body').evaluate((body) => /自定义日期范围|最近多少天|匹配范围|npx playwright install chromium/.exec(body.innerText)?.[0] || '');
    if (removedConfigText) fail(`设置页仍显示应移除的配置项：${removedConfigText}`);
    await page.getByLabel('上游识别引擎').selectOption('efapiao');
    await page.getByLabel('识别模式').selectOption('disabled');
    await page.locator('#tencent-region').fill('ap-guangzhou');
    await expectText(page, '已保存到本机');
    const savedConfig = JSON.parse(await readFile(configPath, 'utf8'));
    if (savedConfig.ocr.credentials.tencentRegion !== 'ap-guangzhou') {
      fail(`配置自动保存未写入腾讯云区域：${savedConfig.ocr.credentials.tencentRegion}`);
    }
    if (savedConfig.ocr.ocrMode !== 'disabled' || savedConfig.filter.since || savedConfig.filter.until) {
      fail(`配置自动保存未正确写入识别模式或未收敛过滤项：${JSON.stringify(savedConfig.ocr)} ${JSON.stringify(savedConfig.filter)}`);
    }
    page.once('dialog', async (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除本机缓存' }).click();
    await expectToast(page, '已重置本机数据');
    await expectText(page, '删除');

    await page.getByRole('link', { name: '关于' }).click();
    await page.waitForURL(/settings\.html/);
    await expectText(page, '数据保存');
    await page.getByTitle('切换到深色主题').click();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (theme !== 'dark') fail(`主题切换失败，实际为 ${theme}`);
    await page.getByRole('button', { name: '打开保存位置' }).click();
    await expectToast(page, '已打开文件夹');
    await page.getByRole('button', { name: '打开待确认文件夹' }).click();
    await expectToast(page, '已打开文件夹');

    const smallWindow = await app.browserWindow(page);
    await smallWindow.evaluate((win) => win.setSize(900, 640));
    await page.waitForTimeout(100);
    await expectNoHorizontalOverflow(page, '900x640 小窗口');
  } finally {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => console.log('Electron full-flow E2E passed'),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
