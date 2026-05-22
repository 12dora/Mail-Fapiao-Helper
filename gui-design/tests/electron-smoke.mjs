import { _electron as electron } from 'playwright';
import { mkdtemp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fail(message) {
  throw new Error(message);
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-electron-'));
  const configPath = join(tmp, 'config.json');
  const statePath = join(tmp, 'state.json');
  await copyFile('config.example.json', configPath);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.paths.samples = join(tmp, 'samples', 'raw');
  config.paths.invoices = join(tmp, 'invoices');
  config.paths.pending = join(tmp, 'pending');
  config.output.dir = join(tmp, 'invoices');
  config.output.pendingDir = join(tmp, 'pending');
  config.output.csv = join(tmp, 'invoices.csv');
  config.ocr.resultsCsv = join(tmp, 'invoices', 'ocr', 'ocr-results.csv');
  config.rename.organizedDir = join(tmp, 'invoices', 'organized');
  await mkdir(config.paths.samples, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, MFH_CONFIG_PATH: configPath, MFH_STATE_PATH: statePath },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByText('按顺序完成三步', { exact: false }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('link', { name: '已有配置，开始处理' }).click();
    await page.waitForURL(/dashboard\.html/);

    const bridgeType = await page.evaluate(() => typeof window.mfhBridge?.getSummary);
    if (bridgeType !== 'function') fail('Electron preload bridge is not available');

    const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (theme !== 'light') fail(`默认主题应为亮色，实际为 ${theme}`);

    const progress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (progress !== '0%') fail(`页面打开时进度条不应启动，实际为 ${progress}`);
    const fileProgress = await page.locator('[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (fileProgress !== '0%') fail(`发票文件进度条不应启动，实际为 ${fileProgress}`);
    await page.getByRole('button', { name: '开始识别发票文件' }).click();
    await page.locator('[data-ocr-log]').getByText('没有待识别文件', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
    const ocrProgress = await page.locator('[data-ocr-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (ocrProgress !== '100%') fail(`没有待识别文件时识别进度应结束，实际为 ${ocrProgress}`);

    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(/config\.html/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) fail('Electron 窗口下配置页存在横向溢出');
    const scrollCheck = await page.evaluate(() => {
      const scroller = document.querySelector('.page');
      if (!scroller) return { ok: false, after: 0, max: 0 };
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = max;
      return { ok: max > 100 && scroller.scrollTop > 0, after: scroller.scrollTop, max };
    });
    if (!scrollCheck.ok) fail(`Electron 配置页不能纵向滚动：${JSON.stringify(scrollCheck)}`);
    const defaultVendor = await page.getByLabel('上游识别引擎').inputValue();
    if (defaultVendor !== 'efapiao') fail(`默认识别后端应为 efapiao，实际为 ${defaultVendor}`);
    const saveButtonCount = await page.getByRole('button', { name: '保存并应用' }).count();
    if (saveButtonCount !== 0) fail('Electron 配置页不应再显示“保存并应用”按钮');
    await page.getByLabel('上游识别引擎').selectOption('efapiao');
    await page.locator('#tencent-region').fill('ap-shanghai');
    await page.getByText('已保存到本机', { exact: false }).waitFor({ state: 'visible', timeout: 5000 });
  } finally {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => console.log('Electron smoke E2E passed'),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
