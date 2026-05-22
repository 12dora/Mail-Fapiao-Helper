import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const fullPath = normalize(join(root, requested));

    if (!fullPath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const body = await readFile(fullPath);
      res.writeHead(200, { 'content-type': mime.get(extname(fullPath)) || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function fail(message) {
  throw new Error(message);
}

async function expectText(page, text) {
  const count = await page.getByText(text, { exact: false }).count();
  if (count < 1) fail(`页面缺少文字：${text}`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.clock.install({ time: new Date('2026-05-21T10:00:00') });
    await page.addInitScript(() => {
      window.__savedConfigPayload = null;
      window.__afterMailDone = false;
      window.__afterFetchDone = false;
      window.__afterOcrDone = false;
      window.__bridgeCalls = [];
      const record = (name, payload) => {
        window.__bridgeCalls.push({ name, payload });
      };
      window.mfhBridge = {
        async getSummary() {
          const history = Array.from({ length: 8 }, (_, index) => ({
            id: `hist-${index}`,
            time: new Date(Date.UTC(2026, 4, 21, 10, index)).toISOString(),
            action: index % 2 === 0 ? 'fetch' : 'ocr',
            title: index % 2 === 0 ? '获取邮件' : '识别发票文件',
            status: 'success',
            message: '已完成',
            detail: '测试记录',
            durationMs: 1200 + index,
          }));
          const inboxRows = window.__afterMailDone ? [
            {
              date: '2026-05-21T08:30:00.000Z',
              from: '国家电网 <noreply@example.com>',
              subject: '国家电网电子发票通知',
              mailbox: 'INBOX',
              hasAttachment: true,
              bodyLinkCount: 3,
            },
            {
              date: '2026-05-20T08:30:00.000Z',
              from: '服务商 <vendor@example.com>',
              subject: '普通通知',
              mailbox: 'INBOX',
              hasAttachment: false,
              bodyLinkCount: 0,
            },
          ] : [];
          const libraryRows = window.__afterFetchDone ? [
            {
              date: '2026-05-21',
              seller: window.__afterOcrDone ? '国家电网有限公司' : '待识别',
              invoiceNo: window.__afterOcrDone ? '123456' : '',
              amount: window.__afterOcrDone ? '¥ 318.42' : '',
              source: window.__afterOcrDone ? '本机识别' : '归档文件',
              filename: '国家电网-318.42.pdf',
              status: window.__afterOcrDone ? '完整' : '待补充',
              documentType: 'invoice',
            },
            {
              date: '2026-05-20',
              seller: '未识别销售方',
              invoiceNo: '',
              amount: '',
              source: '本机识别',
              filename: 'bad.pdf',
              status: '识别失败',
              error: '暂未识别',
              documentType: 'invoice',
            },
          ] : [];
          return {
            configExists: true,
            history,
            inbox: {
              total: inboxRows.length,
              withAttachment: inboxRows.filter((row) => row.hasAttachment).length,
              withLinks: inboxRows.filter((row) => row.bodyLinkCount > 0).length,
              earliestMonth: inboxRows.length ? '2026-05' : '',
              latestMonth: inboxRows.length ? '2026-05' : '',
              rows: inboxRows,
            },
            library: {
              total: window.__afterFetchDone ? 3 : 0,
              recognized: window.__afterOcrDone ? 2 : 0,
              failed: window.__afterFetchDone ? 1 : 0,
              ignored: window.__afterFetchDone ? 1 : 0,
                pending: window.__afterFetchDone && !window.__afterOcrDone ? 3 : 0,
                invoiceLike: window.__afterFetchDone ? 2 : 0,
                itinerary: window.__afterFetchDone ? 1 : 0,
                supporting: window.__afterFetchDone ? 1 : 0,
                ocr: {
                byDocumentType: window.__afterFetchDone ? [
                  { key: 'invoice', count: 2 },
                  { key: 'itinerary', count: 1 },
                  { key: 'supporting', count: 1 },
                ] : [],
              },
              rows: libraryRows,
            },
            pending: {
              total: 1,
              groups: [
                {
                  title: '下载失败或链接过期',
                  count: 1,
                  action: 'refresh_link',
                  description: '需要重新打开平台或手动保存。',
                  rows: [
                    {
                      hash: 'abc123',
                      date: '2026-05-21',
                      from: 'vendor@example.com',
                      subject: '发票下载链接已过期',
                      reason: 'http_403',
                    },
                  ],
                },
              ],
            },
          };
        },
        async getConfig() {
          return {
            configExists: true,
            config: {
              imap: { host: 'imap.test.local', port: 993, user: 'user@test.local' },
              filter: { keywords: ['发票', '行程单'], since: '2026-05-01', until: '2026-05-21', sinceDays: 30 },
              paths: { samples: './samples/raw', invoices: './invoices', pending: './pending' },
              output: { csv: './invoices.csv' },
              rename: { rule: '{seller}-{amount}.pdf', fallback: '{date}-{messageId}.pdf', typeDirRule: '{documentType}' },
              ocr: {
                enabled: true,
                provider: 'efapiao',
                ocrMode: 'auto',
                executionMode: 'auto',
                resultsCsv: './invoices/ocr/ocr-results.csv',
                credentials: { tencentRegion: 'ap-shanghai' },
              },
              playwright: { browserManagement: 'app-managed', timeoutMs: 30000 },
            },
          };
        },
        async startFetch(payload) {
          record('startFetch', payload);
          window.__afterMailDone = true;
          return { ok: true, summary: await window.mfhBridge.getSummary() };
        },
        async runOcr(payload) {
          record('runOcr', payload);
          if (payload?.concurrency !== 1) throw new Error(`runOcr should default to concurrency=1, got ${JSON.stringify(payload)}`);
          window.__ocrProgress?.({ operation: 'ocr', phase: '开始识别', percent: 10, total: 3, processed: 0, parsed: 0, skipped: 0, failed: 0, message: '发现 3 个待识别文件，正在启动识别。' });
          window.__ocrProgress?.({ operation: 'ocr', phase: '正在识别', percent: 50, total: 3, processed: 1, parsed: 1, skipped: 0, failed: 0, message: '识别成功：国家电网-318.42.pdf', kind: 'ok' });
          window.__ocrProgress?.({ operation: 'ocr', phase: '识别完成', percent: 100, total: 3, processed: 3, parsed: 2, skipped: 1, failed: 0, message: '识别完成：成功 2 个，跳过 1 个，失败 0 个。', kind: 'ok', done: true });
          window.__afterOcrDone = true;
          return { ok: true, message: '已扫描 3 个文件，识别成功 2 个，跳过 1 个，失败 0 个。', summary: await window.mfhBridge.getSummary() };
        },
        async organize(payload) {
          record('organize', payload);
          return { ok: true };
        },
        async runPipeline(payload) {
          record('runPipeline', payload);
          if (payload?.avoidConflictBeforeOcr !== true || payload?.force !== false) throw new Error(`runPipeline should default to force=false, got ${JSON.stringify(payload)}`);
          window.__fileProgress?.({ operation: 'files', phase: '开始获取', percent: 10, processed: 0, skipped: 0, failed: 0, message: '正在从本地邮件中获取发票文件。' });
          window.__fileProgress?.({ operation: 'files', phase: '正在获取', percent: 60, processed: 1, skipped: 0, failed: 0, message: '已获取：国家电网电子发票通知', kind: 'ok' });
          window.__fileProgress?.({ operation: 'files', phase: '获取完成', percent: 100, processed: 2, skipped: 0, failed: 0, message: '获取完成：处理 2 封，跳过 0 封，失败 0 封。', kind: 'ok', done: true });
          window.__afterFetchDone = true;
          return { ok: true, message: '已从本地邮件中获取发票文件。', summary: await window.mfhBridge.getSummary() };
        },
        async openPath(payload) {
          record('openPath', payload);
          return { ok: true };
        },
        async copyText(payload) {
          record('copyText', payload);
          return { ok: true };
        },
        async stopOcr() {
          record('stopOcr');
          return { ok: true, message: '正在停止识别。' };
        },
        async testMailConnection() {
          record('testMailConnection');
          return { ok: true, message: '邮箱连接正常，可以获取邮件。' };
        },
        async testConnection() {
          record('testConnection');
          return { ok: true, message: '邮箱连接正常，可以获取邮件。' };
        },
        async developerReset() {
          record('developerReset');
          return { ok: true, removed: ['samples/raw'], summary: await window.mfhBridge.getSummary() };
        },
        async saveConfig(payload) {
          record('saveConfig', payload);
          window.__savedConfigPayload = payload;
          return { ok: true };
        },
        onFetchProgress(callback) {
          setTimeout(() => callback({ percent: 100, matched: 2, saved: 1, skipped: 1, step: '完成', message: '测试完成', done: true }), 20);
        },
        onOperationProgress(callback) {
          window.__ocrProgress = callback;
        },
        onFileProgress(callback) {
          window.__fileProgress = callback;
        },
      };
    });
    await page.goto(`${baseUrl}/pages/dashboard.html`);
    await page.waitForURL(`${baseUrl}/pages/dashboard.html`);

    const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (theme !== 'light') fail(`默认主题应为亮色，实际为 ${theme}`);

    await expectText(page, '开始处理');
    await expectText(page, '邮件记录');
    await expectText(page, '发票库');
    await expectText(page, '待确认');
    await expectText(page, '邮箱已连接');
    await expectText(page, '获取发票文件');
    await expectText(page, '获取发票文件实时日志');
    await expectText(page, '识别发票文件');
    await expectText(page, '识别发票文件实时日志');
    await expectText(page, '获取邮件');
    await expectText(page, '获取邮件实时日志');
    await expectText(page, '最多显示最近 6 条记录');
    await expectText(page, '已获取邮件');
    await expectText(page, '选择日期范围后，点击“开始获取邮件”才会运行');

    const dashboardOrder = await page.evaluate(() => Array.from(document.querySelectorAll('.page h3')).map((el) => el.textContent.trim()));
    const expectedOrder = ['第一步：获取邮件', '获取邮件实时日志', '第二步：获取发票文件', '获取发票文件实时日志', '第三步：识别发票文件（可选）', '识别发票文件实时日志', '本次抓取邮件清单', '最近运行'];
    for (let i = 0; i < expectedOrder.length; i++) {
      if (dashboardOrder[i] !== expectedOrder[i]) fail(`开始处理页区块顺序错误：${JSON.stringify(dashboardOrder)}`);
    }

    const initialProgress = await page.locator('#prog-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (initialProgress !== '0%') fail(`页面打开时进度条不应启动，实际为 ${initialProgress}`);

    // P2-16: ⌘K/Ctrl+K 应聚焦侧边搜索框
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });
    const cmdKFocused = await page.evaluate(() => document.activeElement?.matches('[data-global-search]'));
    if (!cmdKFocused) fail('⌘K 应聚焦全局搜索框');

    await page.getByRole('button', { name: '本周以来' }).click();
    const weekRange = await page.evaluate(() => ({
      from: document.querySelector('#date-from')?.value,
      to: document.querySelector('#date-to')?.value,
      preview: document.querySelector('#range-preview')?.textContent,
    }));
    if (weekRange.from !== '2026-05-18' || weekRange.to !== '2026-05-21') {
      fail(`本周以来日期填充错误：${JSON.stringify(weekRange)}`);
    }
    if (!weekRange.preview?.includes('2026-05-18 至 2026-05-21')) {
      fail(`日期范围预览错误：${weekRange.preview}`);
    }

    const englishLeak = await page.locator('body').evaluate((body) => {
      const text = body.innerText;
      return /(WORKFLOW|SYSTEM|Quick find|Run|Inbox|Library|Pending|Config|About|Completed|recognized|rule_unhandled|action=|manual_archive|travel_detail|order_detail|statement|meal_detail)/.exec(text)?.[0] || '';
    });
    if (englishLeak) fail(`页面仍暴露英文/内部状态：${englishLeak}`);

    // P0-6: 默认勾选状态下 startFetch payload 应带 matchSubject/matchBody=true 且 dryRun=false
    await page.getByRole('button', { name: '开始获取邮件' }).click();
    await page.locator('#run-status').getByText('完成', { exact: false }).waitFor({ state: 'visible', timeout: 6000 });
    const startFetchPayload = await page.evaluate(() => window.__bridgeCalls.find((item) => item.name === 'startFetch')?.payload);
    if (!startFetchPayload || startFetchPayload.matchSubject !== true || startFetchPayload.matchBody !== true || startFetchPayload.dryRun !== false) {
      fail(`startFetch 默认 payload 应带 matchSubject/matchBody=true 且 dryRun=false：${JSON.stringify(startFetchPayload)}`);
    }
    // P0-6: 勾选「只预览，不保存」后 dryRun 必须为 true
    await page.locator('[data-fetch-check="dryRun"]').click();
    await page.getByRole('button', { name: '开始获取邮件' }).click();
    await page.locator('#run-status').getByText('完成', { exact: false }).waitFor({ state: 'visible', timeout: 6000 });
    const dryRunPayload = await page.evaluate(() => window.__bridgeCalls.filter((item) => item.name === 'startFetch').at(-1)?.payload);
    if (!dryRunPayload || dryRunPayload.dryRun !== true) {
      fail(`勾选「只预览，不保存」后 dryRun 应为 true：${JSON.stringify(dryRunPayload)}`);
    }
    await page.locator('[data-fetch-check="dryRun"]').click(); // restore
    const afterFetchMail = await page.evaluate(() => ({
      cached: document.querySelector('[data-dash="cached-mails"]')?.textContent?.trim(),
      navInbox: document.querySelector('[data-nav-badge="inbox"]')?.textContent?.trim(),
    }));
    if (afterFetchMail.cached !== '2' || afterFetchMail.navInbox !== '2') {
      fail(`获取邮件后已获取邮件统计没有刷新：${JSON.stringify(afterFetchMail)}`);
    }
    const afterFetchOcrCounts = await page.evaluate(() => ({
      invoice: document.querySelector('[data-dash="invoice-like"]')?.textContent?.trim(),
      itinerary: document.querySelector('[data-dash="itinerary"]')?.textContent?.trim(),
      supporting: document.querySelector('[data-dash="supporting"]')?.textContent?.trim(),
    }));
    if (afterFetchOcrCounts.invoice !== '0' || afterFetchOcrCounts.itinerary !== '0' || afterFetchOcrCounts.supporting !== '0') {
      fail(`获取邮件后不应已经生成发票文件统计：${JSON.stringify(afterFetchOcrCounts)}`);
    }
    await page.getByRole('link', { name: '邮件记录 2' }).click();
    await page.waitForURL(`${baseUrl}/pages/inbox.html`);
    await page.locator('[data-inbox-rows]').getByText('国家电网电子发票通知', { exact: false }).waitFor({ state: 'visible', timeout: 6000 });
    await page.getByRole('link', { name: '开始处理' }).click();
    await page.waitForURL(`${baseUrl}/pages/dashboard.html`);
    await page.getByRole('button', { name: '开始获取发票文件' }).click();
    await expectText(page, '获取完成：处理 2 封，跳过 0 封，失败 0 封。');
    await page.getByRole('button', { name: '打开文件位置' }).click();
    const fileProgress = await page.locator('[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (fileProgress !== '100%') fail(`获取发票文件进度应到 100%，实际为 ${fileProgress}`);
    const logStyles = await page.evaluate(() => {
      const fileLog = document.querySelector('[data-file-log]');
      const ocrLog = document.querySelector('[data-ocr-log]');
      const mailLog = document.querySelector('#console-out');
      const styleOf = (el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, height: style.height, overflowY: style.overflowY };
      };
      return { file: styleOf(fileLog), ocr: styleOf(ocrLog), mail: styleOf(mailLog) };
    });
    if (logStyles.file.background !== logStyles.ocr.background || logStyles.file.height !== logStyles.ocr.height || logStyles.file.overflowY !== 'auto') {
      fail(`获取/识别日志样式不一致或不可滚动：${JSON.stringify(logStyles)}`);
    }
    const afterFiles = await page.evaluate(() => ({
      invoice: document.querySelector('[data-dash="invoice-like"]')?.textContent?.trim(),
      itinerary: document.querySelector('[data-dash="itinerary"]')?.textContent?.trim(),
      supporting: document.querySelector('[data-dash="supporting"]')?.textContent?.trim(),
    }));
    if (afterFiles.invoice !== '2' || afterFiles.itinerary !== '1' || afterFiles.supporting !== '1') {
      fail(`获取发票文件后统计不正确：${JSON.stringify(afterFiles)}`);
    }
    await page.getByRole('button', { name: '整理识别结果' }).click();
    await page.getByRole('button', { name: '开始识别发票文件' }).click();
    await expectText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。');
    const ocrProgress = await page.locator('[data-ocr-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (ocrProgress !== '100%') fail(`识别进度应到 100%，实际为 ${ocrProgress}`);
    await page.getByRole('button', { name: '查看将要执行的操作' }).click();
    const dashboardCalls = await page.evaluate(() => window.__bridgeCalls.map((item) => item.name));
    for (const expected of ['startFetch', 'runPipeline', 'openPath', 'organize', 'runOcr']) {
      if (!dashboardCalls.includes(expected)) fail(`控制台按钮没有调用 ${expected}: ${dashboardCalls.join(',')}`);
    }
    const historyCards = await page.locator('[data-run-history] .history-item').count();
    if (historyCards > 6) fail(`最近运行最多显示 6 条，实际 ${historyCards}`);

    await page.getByRole('link', { name: '待确认 1' }).click();
    await page.waitForURL(`${baseUrl}/pages/pending.html`);
    await page.getByRole('link', { name: '开始处理' }).click();
    await page.waitForURL(`${baseUrl}/pages/dashboard.html`);
    const preservedFileProgress = await page.locator('[data-file-bar]').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    if (preservedFileProgress !== '100%') fail(`页面切换后获取发票进度不应丢失，实际为 ${preservedFileProgress}`);
    await page.getByRole('link', { name: '待确认 1' }).click();
    await page.waitForURL(`${baseUrl}/pages/pending.html`);
    await expectText(page, '这些邮件大多是历史链接过期');
    await expectText(page, '发票下载链接已过期');
    // P0-8: pending Tab 切换应该真的过滤分组
    await page.getByRole('button', { name: '可忽略' }).click();
    const ignorableGroups = await page.locator('[data-pending-groups] .group').count();
    if (ignorableGroups !== 0) fail(`pending 「可忽略」Tab 应过滤掉 refresh_link 分组，实际剩 ${ignorableGroups} 组`);
    await page.getByRole('button', { name: '刷新链接' }).click();
    const refreshGroups = await page.locator('[data-pending-groups] .group').count();
    if (refreshGroups !== 1) fail(`pending 「刷新链接」Tab 应保留 refresh_link 分组，实际 ${refreshGroups}`);
    await page.getByRole('button', { name: '全部' }).click();
    await page.locator('[data-action="pending-primary"]').click();
    await page.getByRole('button', { name: '打开待确认文件夹' }).first().click();
    await page.getByRole('button', { name: '复制原因' }).click();
    const genericToast = await page.getByText('桌面版中会调用本地程序完成这一步', { exact: false }).count();
    if (genericToast > 0) fail('普通按钮不应再弹出泛化的桌面版提示');
    const pendingCalls = await page.evaluate(() => window.__bridgeCalls.map((item) => item.name));
    if (!pendingCalls.includes('openPath') || !pendingCalls.includes('copyText')) {
      fail(`待确认按钮没有调用文件夹/复制动作：${pendingCalls.join(',')}`);
    }

    await page.getByRole('link', { name: '发票库 2' }).click();
    await page.waitForURL(`${baseUrl}/pages/library.html`);
    await page.locator('[data-search="library"]').fill('国家电网');
    await expectText(page, '国家电网有限公司');
    const badVisibleAfterSearch = await page.getByText('bad.pdf', { exact: false }).count();
    if (badVisibleAfterSearch !== 0) fail('发票库搜索没有过滤不匹配结果');
    await page.locator('[data-search="library"]').fill('');
    await page.getByRole('button', { name: '失败' }).click();
    await expectText(page, 'bad.pdf');
    // P0-7: 「仅失败项」复选过滤要真的生效
    await page.getByRole('button', { name: '全部' }).click();
    const beforeFailedOnly = await page.locator('[data-library-rows] tr').count();
    await page.locator('[data-filter="library-failed"]').click();
    const afterFailedOnly = await page.locator('[data-library-rows] tr').count();
    if (afterFailedOnly === beforeFailedOnly || afterFailedOnly !== 1) {
      fail(`「仅失败项」过滤不生效：before=${beforeFailedOnly} after=${afterFailedOnly}`);
    }
    await page.locator('[data-filter="library-failed"]').click(); // restore
    await page.locator('[data-library-rows]').getByRole('button', { name: '打开' }).first().click();
    const rerunClass = await page.getByRole('button', { name: '重新识别' }).evaluate((el) => el.className);
    if (!String(rerunClass).includes('btn--primary')) fail(`发票库重新识别按钮不是蓝色主按钮：${rerunClass}`);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '重新识别' }).click();
    await expectText(page, '识别完成：成功 2 个，跳过 1 个，失败 0 个。');
    const rerunPayload = await page.evaluate(() => window.__bridgeCalls.filter((item) => item.name === 'runOcr').at(-1)?.payload);
    if (rerunPayload?.resetResults !== true || rerunPayload?.force !== true) fail(`重新识别没有通过 runOcr 原子重置：${JSON.stringify(rerunPayload)}`);
    await page.getByRole('button', { name: '整理输出' }).click();

    await page.getByRole('link', { name: '邮件记录 2' }).click();
    await page.waitForURL(`${baseUrl}/pages/inbox.html`);
    await page.locator('[data-search="inbox"]').fill('国家电网');
    await expectText(page, '国家电网电子发票通知');
    const normalVisible = await page.locator('[data-inbox-rows]').getByText('普通通知', { exact: false }).count();
    if (normalVisible !== 0) fail('邮件搜索没有过滤不匹配结果');

    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(`${baseUrl}/pages/config.html`);
    await expectText(page, '先保存所有发票或行程单原件');
    await expectText(page, 'efapiao（内置）');
    await expectText(page, '这里只设置要找什么内容');
    await expectText(page, '{seller}');
    await expectText(page, '{invoiceNo}');
    const modeHelp = await page.locator('body').evaluate((body) => body.innerText.includes('默认“规则优先，必要时调用 OCR”'));
    if (!modeHelp) fail('设置页缺少 efapiao 识别模式说明');
    await expectText(page, '腾讯云 SecretId');
    await expectText(page, '运行 efapiao 时会作为本地环境变量透传');
    await expectText(page, '当前版本不会调用 LLM');
    await expectText(page, '桌面版会随应用准备浏览器');
    await expectText(page, '修改后自动保存');
    const removedConfigText = await page.locator('body').evaluate((body) => /自定义日期范围|最近多少天|匹配范围|npx playwright install chromium/.exec(body.innerText)?.[0] || '');
    if (removedConfigText) fail(`设置页仍显示应移除的配置项：${removedConfigText}`);
    const saveButtonCount = await page.getByRole('button', { name: '保存并应用' }).count();
    if (saveButtonCount !== 0) fail('设置页不应再显示“保存并应用”按钮');
    const defaultVendor = await page.getByLabel('上游识别引擎').inputValue();
    if (defaultVendor !== 'efapiao') fail(`默认识别后端应为 efapiao，实际为 ${defaultVendor}`);
    const defaultOcrMode = await page.getByLabel('识别模式').inputValue();
    if (defaultOcrMode !== 'auto') fail(`默认识别模式应为 auto，实际为 ${defaultOcrMode}`);
    const mailboxSize = await page.locator('.select--mailboxes').evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      size: el.getAttribute('size'),
    }));
    if (mailboxSize.height < 150 || mailboxSize.size !== '6') {
      fail(`邮箱文件夹选择框过小：${JSON.stringify(mailboxSize)}`);
    }
    const tlsAlignment = await page.locator('.field--compact').evaluate((el) => {
      const label = el.querySelector('.field__label')?.getBoundingClientRect();
      const check = el.querySelector('.check')?.getBoundingClientRect();
      return label && check ? Math.abs(label.left - check.left) : 999;
    });
    if (tlsAlignment > 4) fail(`TLS 勾选框没有在标签下方对齐：${tlsAlignment}`);
    await page.getByRole('button', { name: '测试邮箱连接' }).click();
    await expectText(page, '邮箱连接正常');
    await page.getByLabel('上游识别引擎').selectOption('efapiao');
    await page.getByLabel('识别模式').selectOption('disabled');
    await page.locator('#tencent-secret-id').fill('demo-secret-id');
    await page.locator('#tencent-secret-key').fill('demo-secret-key');
    await page.locator('#tencent-region').fill('ap-guangzhou');
    // P0-1: 邮箱文件夹多选要保存进 imap.mailbox
    await page.locator('.select--mailboxes').selectOption(['INBOX', 'Sent Messages']);
    // P0-2: TLS 勾选框要保存到 imap.tls
    await page.locator('[data-config-check="imap.tls"]').click(); // 关闭一次
    // P0-3 / P0-4: applyAfterOcr / organizeByType 勾选要保存
    await page.locator('[data-config-check="rename.applyAfterOcr"]').click();
    await page.locator('[data-config-check="rename.organizeByType"]').click();
    // P0-5: 网络重试两个输入框要绑定 network.*
    await page.locator('[data-config="network.retries"]').fill('5');
    await page.locator('[data-config="network.retryDelayMs"]').fill('2500');
    await page.getByText('已保存到本机', { exact: false }).waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => window.__savedConfigPayload?.network?.retryDelayMs === 2500);
    const savedPayload = await page.evaluate(() => window.__savedConfigPayload);
    if (!Array.isArray(savedPayload?.imap?.mailbox) || savedPayload.imap.mailbox.length !== 2 || !savedPayload.imap.mailbox.includes('INBOX') || !savedPayload.imap.mailbox.includes('Sent Messages')) {
      fail(`邮箱文件夹多选未保存进 imap.mailbox：${JSON.stringify(savedPayload?.imap)}`);
    }
    if (savedPayload?.imap?.tls !== false) {
      fail(`TLS 勾选状态未保存到 imap.tls：${JSON.stringify(savedPayload?.imap)}`);
    }
    if (savedPayload?.rename?.applyAfterOcr !== true) {
      fail(`「识别后自动改名」未保存到 rename.applyAfterOcr：${JSON.stringify(savedPayload?.rename)}`);
    }
    if (savedPayload?.rename?.organizeByType !== true) {
      fail(`「按类型分目录」未保存到 rename.organizeByType：${JSON.stringify(savedPayload?.rename)}`);
    }
    if (savedPayload?.network?.retries !== 5 || savedPayload?.network?.retryDelayMs !== 2500) {
      fail(`网络重试设置未保存到 network.*：${JSON.stringify(savedPayload?.network)}`);
    }
    if (savedPayload?.ocr?.credentials?.tencentRegion !== 'ap-guangzhou') {
      fail(`配置保存没有携带腾讯 OCR 区域：${JSON.stringify(savedPayload)}`);
    }
    if (savedPayload?.ocr?.ocrMode !== 'disabled' || savedPayload?.filter?.since || savedPayload?.filter?.until || savedPayload?.filter?.sinceDays) {
      fail(`配置保存内容不符合设置页收敛要求：${JSON.stringify(savedPayload)}`);
    }
    if (savedPayload?.playwright?.browserManagement !== 'app-managed') {
      fail(`网页自动下载浏览器策略未保存：${JSON.stringify(savedPayload?.playwright)}`);
    }
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole('button', { name: '删除本机缓存' }).click();
    const configCalls = await page.evaluate(() => window.__bridgeCalls.map((item) => item.name));
    for (const expected of ['testMailConnection', 'saveConfig', 'developerReset']) {
      if (!configCalls.includes(expected)) fail(`设置页按钮没有调用 ${expected}: ${configCalls.join(',')}`);
    }

    await page.getByRole('link', { name: '关于' }).click();
    await page.waitForURL(`${baseUrl}/pages/settings.html`);
    await expectText(page, '数据保存');
    await expectText(page, '识别与隐私');
    const aboutLeak = await page.locator('body').evaluate((body) => /实施进度|设计原则|构建信息|扩展点/.exec(body.innerText)?.[0] || '');
    if (aboutLeak) fail(`关于页仍暴露开发内容：${aboutLeak}`);

    await page.getByTitle('切换到深色主题').click();
    const dark = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
    if (dark !== 'dark') fail(`主题切换失败，实际为 ${dark}`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) fail('页面存在横向溢出');

    await page.getByRole('link', { name: '邮箱与保存' }).click();
    await page.waitForURL(`${baseUrl}/pages/config.html`);
    const scrollCheck = await page.evaluate(() => {
      const scroller = document.querySelector('main.main:not([style*="display: none"]) .page');
      if (!scroller) return { ok: false, before: 0, after: 0, max: 0 };
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = max;
      return { ok: max > 100 && scroller.scrollTop > 0, before: 0, after: scroller.scrollTop, max };
    });
    if (!scrollCheck.ok) fail(`配置页不能纵向滚动：${JSON.stringify(scrollCheck)}`);

    const small = await browser.newPage({ viewport: { width: 900, height: 640 } });
    await small.goto(`${baseUrl}/pages/config.html`);
    const smallOverflow = await small.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (smallOverflow) fail('小窗口下页面存在横向溢出');
    await small.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(
  () => console.log('GUI E2E passed'),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
