/* Browser E2E for the QA-report fixes (H1/H3/H4/H6/H7/M1/M2/M3/M5/L5).
 *
 * CODE-02: this file used to contain an empty `if` body (M1) and a bare
 * `waitForTimeout` (M5) that asserted nothing. Both are now real assertions —
 * see the comments at each block.
 *
 * CODE-03: the HTTP server and the browser are acquired inside one guarded
 * scope, so a missing Chromium no longer leaks a listening socket, and the
 * suite has an overall timeout.
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

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const fullPath = normalize(join(root, requested));
    if (!fullPath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
    try {
      const body = await readFile(fullPath);
      res.writeHead(200, { 'content-type': mime.get(extname(fullPath)) || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function activeMain(page, selector) {
  return page.locator(`main.main:not([style*="display: none"]) ${selector}`);
}

async function main() {
  await withCleanup(async (scope) => {
    // Order matters: the server is registered first, so it is torn down *after*
    // the browser — and, crucially, even when the browser never launches.
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
    await page.addInitScript(() => {
      window.__bridgeCalls = [];
      window.__testConnectionCount = 0;
      window.__pendingPrimaryCount = 0;
      // Released externally — used to delay testMailConnection so we can verify the busy lock.
      window.__releaseTestConnection = null;
      window.__archivedHashes = [];
      window.mfhBridge = {
        async getSummary() {
          const pendingGroups = [
            { title: '链接过期', count: 1, action: 'refresh_link', description: '', rows: [{ hash: 'h1', date: '2026-05-21', from: 'a', subject: 'A', reason: 'http_403' }] },
            { title: '需要手动归档', count: 2, action: 'manual_archive', description: '', rows: [
              { hash: 'h2', date: '2026-05-20', from: 'b', subject: 'B', reason: 'rule_unhandled' },
              { hash: 'h4', date: '2026-05-19', from: 'd', subject: 'D', reason: 'rule_unhandled' },
            ] },
            // An "unknown action" group that, per H7, must NOT show up under 手动归档.
            { title: '某未知动作', count: 1, action: 'some_future_action', description: '', rows: [{ hash: 'h3', date: '2026-05-19', from: 'c', subject: 'C', reason: 'future_action' }] },
          ];
          for (const group of pendingGroups) {
            group.rows = group.rows.filter((row) => !window.__archivedHashes.includes(row.hash));
            group.count = group.rows.length;
          }
          const remaining = pendingGroups.reduce((sum, group) => sum + group.rows.length, 0);
          return {
            configExists: true,
            history: [],
            secrets: { imapPass: true },
            inbox: {
              total: 2, withAttachment: 1, withLinks: 1, earliestMonth: '2026-05', latestMonth: '2026-05',
              rows: [
                { date: '2026-05-21T00:00:00Z', from: 'a@b.com', subject: '附件邮件', mailbox: 'INBOX', hasAttachment: true, bodyLinkCount: 2 },
                { date: '2026-05-20T00:00:00Z', from: 'c@d.com', subject: '纯文本邮件', mailbox: 'INBOX', hasAttachment: false, bodyLinkCount: 0 },
              ],
            },
            library: {
              total: 2, recognized: 0, failed: 0, ignored: 0, pending: 2, invoiceLike: 0, itinerary: 0, supporting: 0,
              rows: [
                { date: '2026-05-21', seller: '甲', invoiceNo: '', amount: '', source: '本机识别', filename: 'has-file.pdf', filePath: '/tmp/has-file.pdf', status: '待补充', documentType: 'invoice' },
                { date: '2026-05-20', seller: '乙', invoiceNo: '', amount: '', source: '本机识别', filename: 'no-file.pdf', filePath: '', status: '待补充', documentType: 'invoice' },
              ],
              ocr: { byDocumentType: [] },
            },
            pending: { total: remaining, groups: pendingGroups },
          };
        },
        async getConfig() {
          return {
            configExists: true,
            // Mimic the new bridge contract: secrets are redacted, with a boolean shadow.
            secrets: { imapPass: true, tencentSecretId: false, tencentSecretKey: false },
            config: {
              imap: { host: 'imap.test', port: 993, user: 'u@test', pass: '', tls: true, mailbox: ['INBOX'] },
              filter: { keywords: ['发票'] },
              paths: { samples: './samples/raw', invoices: './invoices', pending: './pending' },
              output: { csv: './invoices.csv' },
              rename: { rule: '{seller}.pdf', fallback: '{date}.pdf' },
              ocr: { enabled: true, provider: 'efapiao', ocrMode: 'auto', executionMode: 'auto', resultsCsv: './invoices/ocr/ocr-results.csv', credentials: { tencentSecretId: '', tencentSecretKey: '', tencentRegion: 'ap-shanghai' } },
              playwright: { timeoutMs: 30000 },
              network: { retries: 3, retryDelayMs: 1000 },
            },
          };
        },
        async getAppInfo() { return { version: '0.0.0', channel: '测试夹具', packaged: false }; },
        async saveConfig(payload) { window.__bridgeCalls.push({ name: 'saveConfig', payload }); return { ok: true }; },
        async testMailConnection() {
          window.__testConnectionCount += 1;
          window.__bridgeCalls.push({ name: 'testMailConnection' });
          await new Promise((resolve) => { window.__releaseTestConnection = resolve; });
          return { ok: true, message: '邮箱连接正常' };
        },
        async listMailboxes() { window.__bridgeCalls.push({ name: 'listMailboxes' }); return { ok: true, mailboxes: ['INBOX'] }; },
        async pendingIgnore() { window.__bridgeCalls.push({ name: 'pendingIgnore' }); return { ok: true, summary: await window.mfhBridge.getSummary() }; },
        async pendingRefreshLink() { window.__bridgeCalls.push({ name: 'pendingRefreshLink' }); return { ok: true, message: '' }; },
        async pendingManualArchive({ hash }) {
          window.__pendingPrimaryCount += 1;
          window.__bridgeCalls.push({ name: 'pendingManualArchive', payload: { hash } });
          await new Promise((r) => setTimeout(r, 300));
          window.__archivedHashes.push(hash);
          return { ok: true, message: '已归档', summary: await window.mfhBridge.getSummary() };
        },
        async openPath() { window.__bridgeCalls.push({ name: 'openPath' }); return { ok: true }; },
        async copyText(p) { window.__bridgeCalls.push({ name: 'copyText', payload: p }); return { ok: true }; },
        async runOcr() { return { ok: true, summary: await window.mfhBridge.getSummary() }; },
        async runPipeline() { return { ok: true, summary: await window.mfhBridge.getSummary() }; },
        async organize() { return { ok: true, message: '整理完成' }; },
        async stopOcr() { return { ok: true }; },
        async developerReset() { return { ok: true, removed: [], skippedExternal: [], summary: await window.mfhBridge.getSummary() }; },
        async getOpState() { return { running: null }; },
        onOpState() {},
        onFetchProgress() {},
        onOperationProgress() {},
        onFileProgress() {},
      };
    });

    // --- H3: Cmd+K on inbox should not jump to library ---
    await page.goto(`${baseUrl}/pages/inbox.html`);
    await page.waitForFunction(() => document.querySelector('[data-inbox-rows] tr td:not(.muted)'));
    await page.locator('[data-global-search]').fill('附件');
    await page.locator('[data-global-search]').press('Enter');
    const currentPage = await page.evaluate(() => document.body.dataset.page);
    if (currentPage !== 'inbox') fail(`H3 失败：Cmd+K 不应跳出邮件记录页，实际 page=${currentPage}`);
    const inboxSearchVal = await activeMain(page, '[data-search="inbox"]').inputValue();
    if (inboxSearchVal !== '附件') fail(`H3 失败：邮件搜索框未填入关键字，实际=${inboxSearchVal}`);

    // --- H6: ocr-toggle button in library should keep its short label, not borrow dashboard label ---
    await page.goto(`${baseUrl}/pages/library.html`);
    await page.waitForFunction(() => document.querySelector('[data-library-rows]'));
    const libraryOcrText = await activeMain(page, '[data-action="ocr-toggle"]').textContent();
    if (libraryOcrText?.trim() !== '开始识别') fail(`H6 失败：库页 ocr-toggle 文案应为「开始识别」，实际=${libraryOcrText}`);

    /* --- M1: an inbox filter chip must re-render ONLY the inbox table ---
       The previous version compared two row counts and then did nothing with
       the result (an `if` with a comment-only body), so it could not fail.
       Here the library page stays mounted (SPA navigation, not page.goto), a
       sentinel node is planted inside the library <tbody>, and the assertion is
       that the chip filters the inbox *and* leaves the library DOM alone —
       renderLibraryRows() replaces innerHTML, which would destroy the
       sentinel. */
    await page.getByRole('link', { name: /邮件记录/ }).click();
    await page.waitForURL(/inbox\.html/);
    await page.waitForFunction(() => document.querySelectorAll('main.main').length >= 2);
    await page.evaluate(() => {
      const libraryBody = document.querySelector('main.main[data-spa-page="library"] [data-library-rows]');
      if (!libraryBody) throw new Error('library main 没有保持挂载，M1 无法验证');
      const sentinel = document.createElement('tr');
      sentinel.id = 'm1-library-sentinel';
      libraryBody.appendChild(sentinel);
    });
    const inboxRowsBefore = await activeMain(page, '[data-inbox-rows] tr').count();
    if (inboxRowsBefore !== 2) fail(`M1 前置失败：邮件表应有 2 行，实际 ${inboxRowsBefore}`);
    await activeMain(page, '[data-filter="inbox-attachment"]').click();
    const inboxRowsAfter = await activeMain(page, '[data-inbox-rows] tr').count();
    if (inboxRowsAfter !== 1) fail(`M1 失败：「有附件」筛选后应只剩 1 行，实际 ${inboxRowsAfter}`);
    const chipPressed = await activeMain(page, '[data-filter="inbox-attachment"]').getAttribute('aria-pressed');
    if (chipPressed !== 'true') fail(`M1 失败：筛选 chip 没有回报 aria-pressed=true，实际 ${chipPressed}`);
    const sentinelSurvived = await page.evaluate(() => Boolean(document.getElementById('m1-library-sentinel')));
    if (!sentinelSurvived) fail('M1 失败：邮件页筛选连带重绘了发票库表格');
    await activeMain(page, '[data-filter="inbox-attachment"]').click(); // restore

    // --- H7: pending manual_archive tab must NOT include unknown actions ---
    await page.goto(`${baseUrl}/pages/pending.html`);
    await page.waitForFunction(() => document.querySelectorAll('[data-pending-groups] .group').length >= 3);
    // The tab and the collapsible group heading now share the label 「手动归档」,
    // so role+name matching is ambiguous; address the tab by its data hook.
    await activeMain(page, '[data-pending-tab="manual_archive"]').click();
    const manualArchiveGroups = await activeMain(page, '[data-pending-groups] .group').count();
    if (manualArchiveGroups !== 1) fail(`H7 失败：「手动归档」Tab 应只包含 1 个分组，实际 ${manualArchiveGroups}`);
    const manualArchiveTitle = await activeMain(page, '[data-pending-groups] .group__title').first().textContent();
    if (!manualArchiveTitle?.includes('需要手动归档')) fail(`H7 失败：分组标题不对，实际=${manualArchiveTitle}`);
    const unknownGroupVisible = await activeMain(page, '[data-pending-group="some_future_action"]').count();
    if (unknownGroupVisible !== 0) fail('H7 失败：未知动作分组混进了「手动归档」Tab');
    await activeMain(page, '[data-pending-tab="all"]').click();

    /* --- M5: an in-flight pending action locks its peers, and unlocks them ---
       The old version stopped at `waitForTimeout(50)` and asserted nothing
       about the "after" state, so a fix that never re-enabled the peers would
       still have passed. */
    const primaryButtons = activeMain(page, '[data-action="pending-primary"]');
    const totalPrimary = await primaryButtons.count();
    if (totalPrimary < 3) fail(`M5 前置失败：测试需要至少 3 个 pending-primary 按钮，实际=${totalPrimary}`);
    // The unknown-action row must be disabled up front and stay that way.
    const unknownDisabledBefore = await activeMain(page, '[data-pending-row="h3"] [data-action="pending-primary"]').isDisabled();
    if (!unknownDisabledBefore) fail('M5/H7 失败：未知动作的主按钮应始终禁用');

    const target = activeMain(page, '[data-pending-row="h2"] [data-action="pending-primary"]');
    const clickPromise = target.click();
    // While the await is in flight every *other* pending button is disabled.
    await page.waitForFunction(() => {
      const all = Array.from(document.querySelectorAll('main.main:not([style*="display: none"]) [data-action="pending-primary"]'));
      const clicked = document.querySelector('[data-pending-row="h2"] [data-action="pending-primary"]');
      return all.length >= 3 && all.every((el) => el === clicked || el.disabled === true);
    }, null, { timeout: 3000 });
    await clickPromise;

    // The handled row leaves the list …
    await page.locator('[data-pending-row="h2"]').waitFor({ state: 'detached', timeout: 5000 });
    // … exactly one IPC call was made …
    const archiveCalls = await page.evaluate(() => window.__pendingPrimaryCount);
    if (archiveCalls !== 1) fail(`M5 失败：等待期间应只发出 1 次归档请求，实际 ${archiveCalls}`);
    // … and every remaining *supported* row is interactive again.
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('main.main:not([style*="display: none"]) [data-pending-row]'));
      const supported = rows.filter((row) => row.dataset.pendingAction !== 'some_future_action');
      const buttons = supported.map((row) => row.querySelector('[data-action="pending-primary"]')).filter(Boolean);
      return buttons.length >= 2 && buttons.every((el) => el.disabled === false);
    }, null, { timeout: 5000 }).catch(async () => {
      const state = await page.evaluate(() => Array.from(document.querySelectorAll('[data-pending-row]')).map((row) => ({
        hash: row.dataset.pendingRow,
        action: row.dataset.pendingAction,
        disabled: row.querySelector('[data-action="pending-primary"]')?.disabled,
      })));
      fail(`M5 失败：归档完成后同伴按钮没有恢复可用：${JSON.stringify(state)}`);
    });
    const unknownStillDisabled = await activeMain(page, '[data-pending-row="h3"] [data-action="pending-primary"]').isDisabled();
    if (!unknownStillDisabled) fail('M5 失败：恢复可用时把未知动作按钮也一并启用了');
    // The group counter must follow the removal, not keep the stale number.
    const groupCount = await activeMain(page, '[data-pending-group="manual_archive"] .group__count').textContent();
    if (groupCount?.trim() !== '1') fail(`M5 失败：分组计数没有跟随行移除更新，实际=${groupCount}`);

    // --- H1: test-connection button shows busy label and rejects double-click ---
    await page.goto(`${baseUrl}/pages/config.html`);
    await page.waitForFunction(() => document.querySelector('[data-action="test-connection"]'));
    const testBtn = activeMain(page, '[data-action="test-connection"]');
    await testBtn.click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-action="test-connection"]');
      return el && el.dataset.busy === 'true' && el.disabled;
    }, null, { timeout: 3000 });
    const busyLabel = await testBtn.textContent();
    if (!busyLabel?.includes('正在连接邮箱')) fail(`H1 失败：测试连接按钮繁忙文案不正确，实际=${busyLabel}`);
    // Try double-click while busy — should not fire a second IPC call.
    await testBtn.click({ force: true }).catch(() => {});
    await testBtn.click({ force: true }).catch(() => {});
    // Release the bridge promise.
    await page.evaluate(() => window.__releaseTestConnection?.());
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-action="test-connection"]');
      return el && el.dataset.busy !== 'true' && !el.disabled;
    }, null, { timeout: 5000 });
    const count = await page.evaluate(() => window.__testConnectionCount);
    if (count !== 1) fail(`H1 失败：testMailConnection 应只被调用 1 次，实际 ${count}`);

    // --- M3: imap.port required validation ---
    // Connection details live in the collapsed 高级设置 disclosure (COPY-06).
    await activeMain(page, 'details.card summary').first().click();
    await activeMain(page, '[data-config="imap.port"]').fill('');
    const portInvalid = await activeMain(page, '[data-config="imap.port"]').evaluate((el) => el.classList.contains('is-invalid'));
    if (!portInvalid) fail('M3 失败：清空 imap.port 应标记 is-invalid');
    const saveState = await activeMain(page, '#save-state').textContent();
    if (!saveState?.includes('未保存')) fail(`M3 失败：清空 imap.port 后应阻止保存，实际状态=${saveState}`);
    // The error must name the field and its legal range, not just say "invalid".
    const portError = await activeMain(page, '[data-config="imap.port"] ~ .field__error').first().textContent();
    if (!portError?.includes('收件服务器端口') || !portError.includes('1–65535')) {
      fail(`M3 失败：错误提示没有指明字段名和取值范围，实际=${portError}`);
    }
    const savesWhileInvalid = await page.evaluate(() => window.__bridgeCalls.filter((c) => c.name === 'saveConfig').length);
    await page.waitForTimeout(700); // longer than the 450ms autosave debounce
    const savesAfterDebounce = await page.evaluate(() => window.__bridgeCalls.filter((c) => c.name === 'saveConfig').length);
    if (savesAfterDebounce !== savesWhileInvalid) {
      fail(`M3 失败：字段非法时仍然触发了 saveConfig（${savesWhileInvalid} → ${savesAfterDebounce}）`);
    }
    await activeMain(page, '[data-config="imap.port"]').fill('993'); // restore

    // --- L5: open-row-file button should be disabled when filePath empty ---
    await page.goto(`${baseUrl}/pages/library.html`);
    await page.waitForFunction(() => document.querySelectorAll('[data-action="open-row-file"]').length >= 2);
    const disabledStates = await activeMain(page, '[data-action="open-row-file"]').evaluateAll((els) => els.map((el) => ({ disabled: el.disabled, path: el.dataset.filePath })));
    const hasFileBtn = disabledStates.find((s) => s.path);
    const noFileBtn = disabledStates.find((s) => !s.path);
    if (!hasFileBtn || hasFileBtn.disabled) fail(`L5 失败：有 filePath 的「打开」按钮应可点击：${JSON.stringify(hasFileBtn)}`);
    if (!noFileBtn || !noFileBtn.disabled) fail(`L5 失败：空 filePath 的「打开」按钮应禁用：${JSON.stringify(noFileBtn)}`);

    // --- H4: export-log should skip placeholders ---
    await page.goto(`${baseUrl}/pages/dashboard.html`);
    await page.waitForFunction(() => document.querySelector('[data-action="export-log"]'));
    await page.evaluate(() => { window.__bridgeCalls = []; });
    await activeMain(page, '[data-action="export-log"]').click();
    const exported = await page.evaluate(() => window.__bridgeCalls.find((c) => c.name === 'copyText')?.payload?.text);
    if (exported && (exported.includes('选择日期范围后') || exported.includes('点击') || exported.includes('待命'))) {
      fail(`H4 失败：导出日志不应包含占位提示，实际=${exported}`);
    }
    if (exported !== '暂无实时日志') fail(`H4 失败：无真实日志时导出应为「暂无实时日志」，实际=${exported}`);

    // --- M2: redacted config must not leak the original password to renderer ---
    await page.goto(`${baseUrl}/pages/config.html`);
    await page.waitForFunction(() => window.FPH?.configPayload);
    const leak = await page.evaluate(() => window.FPH.configPayload?.config?.imap?.pass);
    if (leak && leak.length > 0) fail(`M2 失败：渲染进程收到了非空密码：${leak}`);
    const passField = await activeMain(page, '[data-config="imap.pass"]').inputValue();
    if (passField !== '') fail(`M2 失败：密码输入框不应被预填，实际=${passField}`);
    const passPlaceholder = await activeMain(page, '[data-config="imap.pass"]').getAttribute('placeholder');
    if (!passPlaceholder?.includes('已保存') && !passPlaceholder?.includes('留空')) fail(`M2 失败：占位提示应表明密码已保存，实际=${passPlaceholder}`);
  });
}

await runSuite('GUI E2E fixes', main, { timeoutMs: 4 * 60 * 1000 });
