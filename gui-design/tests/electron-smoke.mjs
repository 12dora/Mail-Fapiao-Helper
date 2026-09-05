/* Electron smoke test: the app boots, loads the single renderer page, routes,
 * and keeps the trusted-sender contract after hash navigation.
 *
 * No fake CLI here — the real main process runs against an empty temp data dir,
 * so every number on screen is 0 and every long-running button is expected to
 * report "nothing to do" rather than pretend to succeed.
 *
 * The IPC surface itself is covered by electron-ipc-fixture.mjs; this file is
 * the "does the shell come up at all" gate.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertFreshBuild, fail, repoRoot, runSuite, useTempDir, withCleanup } from './_shared.mjs';
import {
  ROUTES,
  cspViolations,
  firstAppWindow,
  gotoRoute,
  launchElectronApp,
  pageTitle,
  seedDataDir,
  tid,
} from './ui-helpers.mjs';

let checks = 0;
function check(label, condition, detail = '') {
  checks++;
  if (!condition) fail(`${label}${detail ? `：${detail}` : ''}`);
}

/** The window may only ever be gui-design/index.html — query and hash aside. */
function assertCanonicalPage(url, where) {
  const base = url.split('#')[0].split('?')[0];
  check(`${where} 加载的不是 gui-design/index.html`, base.endsWith('/gui-design/index.html'), url);
  check(`${where} 不是 file: 页面`, base.startsWith('file://'), url);
}

async function main() {
  await assertFreshBuild();

  await withCleanup(async (scope) => {
    const tmp = await useTempDir(scope, 'mfh-electron-smoke-');
    const seeded = await seedDataDir(tmp);
    const app = await launchElectronApp(scope, seeded);
    const { page, problems } = await firstAppWindow(app);

    /* ---------- 页面身份与 preload 契约 --------------------------------- */
    assertCanonicalPage(page.url(), '启动时');

    const bridge = await page.evaluate(() => ({
      getSummary: typeof window.mfhBridge?.getSummary,
      getAppInfo: typeof window.mfhBridge?.getAppInfo,
      onOpState: typeof window.mfhBridge?.onOpState,
      openMail: typeof window.mfhBridge?.openMail,
    }));
    check('preload 未暴露 getSummary', bridge.getSummary === 'function', bridge.getSummary);
    // 侧栏与关于页的版本/渠道必须来自主进程，不能是写死的字面量。
    check('preload 未暴露 getAppInfo', bridge.getAppInfo === 'function', bridge.getAppInfo);
    // 操作互斥广播契约。
    check('preload 未暴露 onOpState', bridge.onOpState === 'function', bridge.onOpState);
    check('preload 未暴露 openMail', bridge.openMail === 'function', bridge.openMail);

    /* ---------- 侧栏五个路由 -------------------------------------------- */
    const navLabels = await page.locator('[data-testid^="nav-"]').allInnerTexts();
    check('侧栏没有渲染出五个路由', navLabels.length === ROUTES.length, navLabels.join('/'));
    for (const route of ROUTES) {
      const label = await tid(page, `nav-${route.key}`).innerText();
      check(`侧栏缺少「${route.title}」`, label.trim().startsWith(route.title), label);
    }

    /* ---------- 逐个路由：标题 + hash + 页面身份不变 --------------------- */
    for (const route of ROUTES) {
      await gotoRoute(page, route.key);
      const title = await pageTitle(page);
      check(`${route.key} 的标题不对`, title === route.title, `实际「${title}」`);
      const url = page.url();
      check(`${route.key} 没有落在自己的 hash 上`, url.includes(`#/${route.key}`), url);
      // 换成 pushState 会产生新的 file: 路径，isCanonicalAppPageUrl 会拒绝，
      // 随后所有 IPC 都会被 trusted-sender 挡掉。
      assertCanonicalPage(url, route.title);
    }

    /* ---------- hash 导航之后 IPC 依然可用（trusted-sender）-------------- */
    const afterNav = await page.evaluate(async () => {
      const info = await window.mfhBridge.getAppInfo();
      const summary = await window.mfhBridge.getSummary({ inboxLimit: 10, libraryLimit: 10 });
      const opState = await window.mfhBridge.getOpState();
      return { version: info?.version, channel: info?.channel, inbox: summary?.inbox?.total, running: opState?.running };
    });
    check('hash 导航后 getAppInfo 被 trusted-sender 挡掉了', typeof afterNav.version === 'string', JSON.stringify(afterNav));
    check('主进程返回的版本号不合法', /^\d+\.\d+\.\d+/.test(afterNav.version ?? ''), afterNav.version ?? '');
    check('hash 导航后 getSummary 拿不到数据', afterNav.inbox === 0, JSON.stringify(afterNav));
    check('空数据目录下不应有任务在跑', afterNav.running === null, JSON.stringify(afterNav.running));

    const packageVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
    check('主进程版本号与 package.json 不一致', afterNav.version === packageVersion, `${afterNav.version} ≠ ${packageVersion}`);

    /* ---------- 侧栏版本来自 app.getVersion() ---------------------------- */
    const footer = await page.locator('.mfh-sider__foot').innerText();
    check('侧栏没有显示主进程返回的版本号', footer.includes(`v${afterNav.version}`), footer);

    /* ---------- 空数据目录：统计全是 0，没有假装成功 --------------------- */
    await gotoRoute(page, 'dashboard');
    const stats = await page.locator('.mfh-stat__value').allInnerTexts();
    check('空数据目录下统计卡应全为 0', stats.length === 4 && stats.every((n) => n.trim() === '0'), stats.join('/'));

    await gotoRoute(page, 'library');
    await page
      .getByText('还没有归档的发票')
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => fail('空数据目录下发票库没有显示空状态'));
    checks++;

    /* ---------- 控制台与 CSP ------------------------------------------- */
    const violations = await cspViolations(page);
    check('渲染层触发了 CSP 违规', violations.length === 0, violations.join('; '));
    check('渲染层输出了控制台错误', problems.length === 0, problems.join('; '));

    console.log(`Electron 冒烟断言数：${checks}`);
  });
}

await runSuite('Electron smoke E2E', main, { timeoutMs: 3 * 60 * 1000 });
