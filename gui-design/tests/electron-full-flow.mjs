import { _electron as electron } from 'playwright';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fail(message) {
  throw new Error(message);
}

async function expectText(page, text, timeout = 8000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
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
  config.rename.organizedDir = join(tmp, 'invoices', 'organized');
  await mkdir(config.paths.samples, { recursive: true });
  await mkdir(config.paths.invoices, { recursive: true });
  await mkdir(config.paths.pending, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const app = await electron.launch({
    args: ['.'],
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
    await expectText(page, '按顺序完成三步');
    await expectNoHorizontalOverflow(page, '首页');

    const bridgeType = await page.evaluate(() => typeof window.mfhBridge?.startFetch);
    if (bridgeType !== 'function') fail('Electron preload bridge 不可用');

    await page.getByRole('link', { name: '已有配置，开始处理' }).click();
    await page.waitForURL(/dashboard\.html/);
    await expectText(page, '运行控制台');
    await expectNoHorizontalOverflow(page, '运行控制台');

    const initialProgress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (initialProgress !== '0%') fail(`初始进度应为 0%，实际为 ${initialProgress}`);

    await page.getByRole('button', { name: '本周以来' }).click();
    await expectText(page, '2026-05-18 至 2026-05-21');
    await page.getByRole('button', { name: '查看将要执行的操作' }).click();
    await expectToast(page, '将要执行');

    await page.getByRole('button', { name: '开始抓取' }).click();
    await page.locator('#run-status').getByText('完成', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
    await expectText(page, '已保存 2 封新邮件');
    await expectText(page, '国家电网电子发票通知');
    const progress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (progress !== '100%') fail(`抓取后进度应为 100%，实际为 ${progress}`);

    const afterFetch = await page.evaluate(() => ({
      cached: document.querySelector('[data-dash="cached-mails"]')?.textContent?.trim(),
      invoice: document.querySelector('[data-dash="invoice-like"]')?.textContent?.trim(),
      itinerary: document.querySelector('[data-dash="itinerary"]')?.textContent?.trim(),
      supporting: document.querySelector('[data-dash="supporting"]')?.textContent?.trim(),
    }));
    if (afterFetch.cached !== '2' || afterFetch.invoice !== '1' || afterFetch.itinerary !== '1' || afterFetch.supporting !== '1') {
      fail(`抓取/处理后首页统计不正确：${JSON.stringify(afterFetch)}`);
    }

    await page.getByRole('button', { name: '开始识别' }).first().click();
    await expectToast(page, '识别完成');
    await expectText(page, '已扫描 3 个文件，识别成功 2 个');
    const afterOcr = await page.evaluate(() => ({
      recognized: document.querySelector('[data-dash="recognized"]')?.textContent?.trim(),
      pending: document.querySelector('[data-dash="pending-total"]')?.textContent?.trim(),
    }));
    if (afterOcr.recognized !== '2' || afterOcr.pending !== '1 封') {
      fail(`识别后统计不正确：${JSON.stringify(afterOcr)}`);
    }

    await page.getByRole('button', { name: '整理输出' }).first().click();
    await expectToast(page, '整理完成');
    await page.getByRole('button', { name: '刷新列表' }).click();
    await expectToast(page, '已刷新');
    await page.getByRole('button', { name: '导出结果' }).click();
    await expectToast(page, '已复制');
    await page.getByRole('button', { name: '导出日志' }).click();
    await expectToast(page, '已复制');

    await page.getByRole('link', { name: /邮件记录/ }).click();
    await page.waitForURL(/inbox\.html/);
    await expectText(page, '邮件记录');
    await expectText(page, '国家电网电子发票通知');
    await expectNoHorizontalOverflow(page, '邮件记录');
    await page.locator('[data-search="inbox"]').fill('国家电网');
    const filteredInboxRows = await countRows(page, '[data-inbox-rows]');
    if (filteredInboxRows !== 1) fail(`邮件搜索后应只剩 1 行，实际 ${filteredInboxRows}`);
    await page.locator('[data-filter="inbox-attachment"]').click();
    await page.locator('[data-filter="inbox-links"]').click();
    await page.getByRole('button', { name: '导出表格' }).click();
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
    await page.locator('[data-library-rows]').getByText('行程单.pdf', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('button', { name: '打开归档目录' }).click();
    await expectToast(page, '已打开文件夹');
    await page.getByRole('button', { name: '开始识别' }).click();
    await expectToast(page, '识别完成');
    await page.getByRole('button', { name: '整理输出' }).click();
    await expectToast(page, '整理完成');

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
    await page.getByRole('button', { name: '导出清单' }).click();
    await expectToast(page, '已复制');
    await page.getByRole('button', { name: '刷新列表' }).first().click();
    await expectToast(page, '已刷新');

    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(/config\.html/);
    await expectText(page, '配置');
    await expectNoHorizontalOverflow(page, '配置');
    await page.getByRole('button', { name: '测试配置' }).click();
    await expectToast(page, '配置可用');
    await page.getByLabel('上游识别引擎').selectOption('efapiao');
    await page.locator('#tencent-region').fill('ap-guangzhou');
    await expectText(page, '已保存到本机');
    const savedConfig = JSON.parse(await readFile(configPath, 'utf8'));
    if (savedConfig.ocr.credentials.tencentRegion !== 'ap-guangzhou') {
      fail(`配置自动保存未写入腾讯云区域：${savedConfig.ocr.credentials.tencentRegion}`);
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
