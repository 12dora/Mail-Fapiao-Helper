/* Electron smoke test: the app boots, the preload bridge is wired, and the
 * empty-state paths behave. No fake CLI here — the real main process runs, and
 * the OCR button is expected to report "no work" because the temp data dir is
 * empty.
 *
 * CODE-03: every resource is acquired inside a guarded scope with a launch
 * timeout and process-tree termination on the way out.
 */

import { _electron as electron } from 'playwright';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NO_GUI_E2E_ENV,
  assertFreshBuild,
  closeElectronApp,
  electronTestEnv,
  fail,
  repoRoot,
  runSuite,
  useTempDir,
  withCleanup,
} from './_shared.mjs';

const LAUNCH_TIMEOUT_MS = 60000;

function activeMain(page, selector) {
  return page.locator(`main.main:not([style*="display: none"]) ${selector}`);
}

async function main() {
  await assertFreshBuild();

  await withCleanup(async (scope) => {
    const tmp = await useTempDir(scope, 'mfh-electron-smoke-');
    const configPath = join(tmp, 'config.json');
    const statePath = join(tmp, 'state.json');
    const userDataPath = join(tmp, 'user-data');
    await copyFile(join(repoRoot, 'config.example.json'), configPath);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.paths.samples = join(tmp, 'samples', 'raw');
    config.paths.invoices = join(tmp, 'invoices');
    config.paths.pending = join(tmp, 'pending');
    // schema v3: output only carries `csv`; the actual directories come from
    // paths.*. Writing output.dir / output.pendingDir here would seed a dead
    // field that the migration silently drops.
    config.output.csv = join(tmp, 'invoices.csv');
    config.ocr.resultsCsv = join(tmp, 'invoices', 'ocr', 'ocr-results.csv');
    config.rename.organizedDir = join(tmp, 'invoices', 'organized');
    await mkdir(config.paths.samples, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const launchEnv = electronTestEnv({ MFH_CONFIG_PATH: configPath, MFH_STATE_PATH: statePath });
    if (launchEnv[NO_GUI_E2E_ENV] !== '1') fail('Electron smoke test must launch with MFH_E2E_NO_GUI=1');

    const app = await scope.use(
      'Electron 应用',
      () => electron.launch({
        cwd: repoRoot,
        args: ['.', `--user-data-dir=${userDataPath}`],
        timeout: LAUNCH_TIMEOUT_MS,
        env: launchEnv,
      }),
      (launched) => closeElectronApp(launched),
      { timeoutMs: LAUNCH_TIMEOUT_MS + 10000 },
    );

    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    const browserWindow = await app.browserWindow(page);
    const visible = await browserWindow.evaluate((win) => win.isVisible());
    if (visible) fail('MFH_E2E_NO_GUI=1 should keep the Electron BrowserWindow hidden');
    await page.waitForLoadState('domcontentloaded');
    await activeMain(page, '.toolbar__title').getByText('运行控制台', { exact: false }).waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForURL(/dashboard\.html/);

    const bridge = await page.evaluate(() => ({
      getSummary: typeof window.mfhBridge?.getSummary,
      getAppInfo: typeof window.mfhBridge?.getAppInfo,
      onOpState: typeof window.mfhBridge?.onOpState,
    }));
    if (bridge.getSummary !== 'function') fail('Electron preload bridge is not available');
    // COPY-07B: About/sidebar metadata must come from the main process, not from
    // hardcoded HTML, so the bridge has to expose it.
    if (bridge.getAppInfo !== 'function') fail('preload 未暴露 getAppInfo（关于页版本/渠道必须来自主进程）');
    if (bridge.onOpState !== 'function') fail('preload 未暴露 onOpState（操作互斥广播契约）');

    const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (theme !== 'light') fail(`默认主题应为亮色，实际为 ${theme}`);

    const progress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (progress !== '0%') fail(`页面打开时进度条不应启动，实际为 ${progress}`);
    const fileProgress = await activeMain(page, '[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (fileProgress !== '0%') fail(`发票文件进度条不应启动，实际为 ${fileProgress}`);

    // Empty data dir → the OCR run must report "no work", not pretend to succeed.
    await page.getByRole('button', { name: '开始识别发票文件' }).click();
    await activeMain(page, '[data-ocr-log]').getByText('没有待识别文件', { exact: false }).waitFor({ state: 'visible', timeout: 15000 });
    const ocrProgress = await activeMain(page, '[data-ocr-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (ocrProgress !== '100%') fail(`没有待识别文件时识别进度应结束，实际为 ${ocrProgress}`);

    // COPY-07B: the sidebar version pill must render app.getVersion(), never a
    // hardcoded literal.
    const appInfo = await page.evaluate(() => window.mfhBridge.getAppInfo());
    if (!/^\d+\.\d+\.\d+/.test(String(appInfo?.version || ''))) {
      fail(`主进程返回的版本号不合法：${JSON.stringify(appInfo)}`);
    }
    const sidebarVersion = await page.locator('[data-app-version]').first().textContent();
    if (sidebarVersion?.trim() !== `v${appInfo.version}`) {
      fail(`侧栏版本号应来自 app.getVersion()，期望 v${appInfo.version}，实际 ${sidebarVersion}`);
    }

    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(/config\.html/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) fail('Electron 窗口下配置页存在横向溢出');
    const scrollCheck = await page.evaluate(() => {
      const scroller = document.querySelector('main.main:not([style*="display: none"]) .page');
      if (!scroller) return { ok: false, after: 0, max: 0 };
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = max;
      return { ok: max > 100 && scroller.scrollTop > 0, after: scroller.scrollTop, max };
    });
    if (!scrollCheck.ok) fail(`Electron 配置页不能纵向滚动：${JSON.stringify(scrollCheck)}`);

    // Locate the recognition controls by their stable ids: the visible Chinese
    // labels are product copy and have already been reworded once (COPY-06).
    const defaultVendor = await activeMain(page, '#ocr-vendor').inputValue();
    if (defaultVendor !== 'efapiao') fail(`默认识别后端应为 efapiao，实际为 ${defaultVendor}`);
    const vendorLabel = await activeMain(page, 'label[for="ocr-vendor"]').textContent();
    if (!vendorLabel?.trim()) fail('识别开关缺少可见 label（无障碍要求每个字段都有标签）');
    const saveButtonCount = await page.getByRole('button', { name: '保存并应用' }).count();
    if (saveButtonCount !== 0) fail('Electron 配置页不应再显示“保存并应用”按钮');

    await activeMain(page, '#ocr-vendor').selectOption('efapiao');
    await activeMain(page, '#tencent-region').fill('ap-shanghai');
    await activeMain(page, '#save-state').getByText('已保存到本机', { exact: false }).waitFor({ state: 'visible', timeout: 8000 });
    // The pill is not proof: the value must be on disk.
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    if (saved.ocr.credentials.tencentRegion !== 'ap-shanghai') {
      fail(`自动保存没有把腾讯云区域写入配置文件：${JSON.stringify(saved.ocr.credentials)}`);
    }
  });
}

await runSuite('Electron smoke E2E', main, { timeoutMs: 3 * 60 * 1000 });
