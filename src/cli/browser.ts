import { chromium, type Browser } from 'playwright';
import type { Config } from '../config.js';

/**
 * 可选浏览器启动（APP-19 / EXT-09 / WIRE-03）。
 *
 * 当前站点处理器均不依赖 Playwright page，普通 HTTP 下载不需要浏览器。
 * 仅当未来 handler 声明需要浏览器、或显式调用 getBrowser 时才会走到这里。
 * 应用**不会**自动下载浏览器；桌面版优先系统 Chrome / Edge。
 */
export async function launchBrowser(cfg: Config): Promise<Browser> {
  const launchOptions = { headless: cfg.playwright.headless, timeout: cfg.playwright.timeoutMs };
  const desktopApp = process.env.MFH_APP_ROOT || process.env.MFH_RESOURCE_ROOT;
  const failures: string[] = [];
  const attempts: Array<() => Promise<Browser>> = desktopApp
    ? [
      () => chromium.launch({ ...launchOptions, channel: 'chrome' }),
      () => chromium.launch({ ...launchOptions, channel: 'msedge' }),
      () => chromium.launch(launchOptions),
    ]
    : [
      () => chromium.launch(launchOptions),
      () => chromium.launch({ ...launchOptions, channel: 'chrome' }),
      () => chromium.launch({ ...launchOptions, channel: 'msedge' }),
    ];
  for (const attempt of attempts) {
    try { return await attempt(); } catch (err) { failures.push(err instanceof Error ? err.message : String(err)); }
  }
  throw new Error(
    '可选的浏览器自动化未能启动：本机没有找到可用的 Chrome、Microsoft Edge 或 Playwright Chromium。'
    + '当前发票站点下载默认只走 HTTP，一般不需要浏览器；若你未使用依赖浏览器的扩展处理器，可忽略本错误。'
    + `原始错误：${failures[failures.length - 1] ?? 'unknown'}`,
  );
}
