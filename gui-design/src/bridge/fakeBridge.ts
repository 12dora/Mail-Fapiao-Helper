/**
 * 浏览器预览用的内存桥接。
 *
 * 打开条件：`window.mfhBridge` 不存在，或 URL 带 `?fake=1`（截图脚本用这个）。
 * 数据形状与真实 IPC 完全一致——改 types.ts 时这里也要跟着改，否则页面作者会
 * 对着不存在的字段写界面。数据是确定性生成的，同一次构建的截图可复现。
 */
import type {
  AppInfo,
  AppSummary,
  ArchiveJournalStatus,
  BaseResult,
  ConfigPayload,
  DedupePayload,
  DedupeResult,
  DeveloperResetResult,
  FetchProgress,
  FileProgress,
  InboxRow,
  InboxStatus,
  InvoiceDetailResult,
  InvoiceRow,
  LibraryStatus,
  ListMailboxesResult,
  MailDetailResult,
  MfhBridge,
  OpenMailResult,
  OpenResult,
  OperationProgress,
  OpState,
  OrganizeResult,
  PendingGroup,
  PendingIgnoreResult,
  PendingManualArchiveResult,
  RunHistoryEntry,
  RunningOp,
  SaveConfigResult,
  StartFetchPayload,
  TerminalResult,
  TestConnectionResult,
} from './types.js';

// ---------------------------------------------------------------------------
// 确定性随机
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

const SELLERS = [
  '滴滴出行科技有限公司',
  '北京三快在线科技有限公司',
  '中国铁路网络有限公司',
  '上海携程商务有限公司',
  '深圳市腾讯计算机系统有限公司',
  '阿里云计算有限公司',
  '广州白云国际机场股份有限公司',
  '杭州每日优鲜电子商务有限公司',
  '成都天府酒店管理有限公司',
  '顺丰速运有限公司',
];

const SENDERS = [
  'billing@didiglobal.com',
  'invoice@meituan.com',
  'noreply@12306.cn',
  'fapiao@ctrip.com',
  'invoice@tencent.com',
  'billing@aliyun.com',
  'einvoice@sf-express.com',
  'service@nuonuo.com',
];

const SUBJECTS = [
  '您的电子发票已开具',
  '行程单已生成，请查收',
  '发票开具成功通知',
  '订单 {n} 电子发票',
  '您有一张增值税电子普通发票待下载',
  '铁路电子客票报销凭证',
  '本月账单与发票',
  '住宿费专用发票已寄出',
];

const DOC_TYPES = ['增值税电子普通发票', '铁路电子客票', '航空运输电子客票行程单', '支撑材料'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 固定基准日，保证截图可复现。 */
const BASE = Date.UTC(2026, 8, 5, 9, 0, 0);

function dayStamp(offsetDays: number, hour: number, minute: number): string {
  const d = new Date(BASE - offsetDays * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(hour)}:${pad(minute)}`;
}

function dateOnly(offsetDays: number): string {
  const d = new Date(BASE - offsetDays * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// 数据集
// ---------------------------------------------------------------------------

const INBOX_STATUSES: InboxStatus[] = ['archived', 'archived', 'archived', 'pending', 'unprocessed', 'ignored'];

function buildInbox(): InboxRow[] {
  const rng = makeRng(20260905);
  const rows: InboxRow[] = [];
  for (let i = 0; i < 62; i++) {
    const status = INBOX_STATUSES[i % INBOX_STATUSES.length] as InboxStatus;
    const hasAttachment = rng() > 0.42;
    const subject = pick(rng, SUBJECTS).replace('{n}', String(880000 + i * 37));
    rows.push({
      mailHash: `m${(1000 + i).toString(16)}${(i * 7919).toString(16)}`.slice(0, 16),
      messageId: `<mfh-${1000 + i}@mail.example.com>`,
      date: dayStamp(Math.floor(i * 0.7), 8 + (i % 11), (i * 13) % 60),
      from: pick(rng, SENDERS),
      subject,
      mailbox: i % 9 === 0 ? 'Sent Messages' : 'INBOX',
      hasAttachment,
      bodyLinkCount: hasAttachment ? Math.floor(rng() * 2) : 1 + Math.floor(rng() * 4),
      status,
      documentCount: status === 'archived' ? 1 + Math.floor(rng() * 2) : 0,
      mailOpenable: status !== 'unprocessed',
    });
  }
  return rows;
}

const LIBRARY_STATUSES: LibraryStatus[] = ['完整', '完整', '完整', '完整', '信息不完整', '已归档', '识别失败'];

function buildLibrary(inbox: InboxRow[]): InvoiceRow[] {
  const rng = makeRng(864213);
  const rows: InvoiceRow[] = [];
  for (let i = 0; i < 124; i++) {
    const status = LIBRARY_STATUSES[i % LIBRARY_STATUSES.length] as LibraryStatus;
    const mail = inbox[i % inbox.length] as InboxRow;
    const documentType = pick(rng, DOC_TYPES);
    const complete = status === '完整';
    const format = i % 6 === 0 ? 'ofd' : 'pdf';
    const invoiceNo = complete ? `${24312000000000000000 + i * 17}`.slice(0, 20) : '';
    rows.push({
      date: dateOnly(Math.floor(i * 0.4)),
      seller: complete ? pick(rng, SELLERS) : '',
      invoiceNo,
      amount: complete ? (12 + rng() * 4200).toFixed(2) : '',
      source: '',
      filename: `${dateOnly(Math.floor(i * 0.4))}-${1000 + i}.${format}`,
      filePath: `invoices/${dateOnly(Math.floor(i * 0.4))}-${1000 + i}.${format}`,
      fileHandle: `invoices/${dateOnly(Math.floor(i * 0.4))}-${1000 + i}.${format}`,
      status,
      documentType,
      invoiceType: complete ? (documentType === '增值税电子普通发票' ? '电子普通发票' : '电子票据') : '',
      error: status === '识别失败' ? '识别服务返回空结果' : '',
      mailHash: mail.mailHash,
      messageId: mail.messageId,
      from: mail.from,
      subject: mail.subject,
      contentHash: `c${(i * 104729).toString(16).padStart(12, '0')}`,
      duplicateGroup: '',
      duplicateCount: 0,
    });
  }

  // 造 4 组同号重复：把后面的行改写成前面某一行的发票号与金额。
  const pairs: [number, number][] = [
    [3, 61],
    [10, 74],
    [17, 88],
    [24, 101],
  ];
  for (const [keep, dup] of pairs) {
    const a = rows[keep];
    const b = rows[dup];
    if (!a || !b || !a.invoiceNo) continue;
    b.invoiceNo = a.invoiceNo;
    b.seller = a.seller;
    b.amount = a.amount;
    b.status = '完整';
    b.documentType = a.documentType;
    for (const row of [a, b]) {
      row.duplicateGroup = a.invoiceNo;
      row.duplicateCount = 2;
    }
  }
  return rows;
}

function buildPending(inbox: InboxRow[]): PendingGroup[] {
  const candidates = inbox.filter((row) => row.status === 'pending');
  const slice = (from: number, count: number) =>
    candidates.slice(from, from + count).map((row) => ({
      hash: row.mailHash,
      messageId: row.messageId,
      date: row.date,
      from: row.from,
      subject: row.subject,
      reason: 'download_failed',
      machineReason: 'download_failed',
      category: '下载失败',
      userMessage: '发票链接已失效。',
      nextStep: '到开票平台重新下载后手动归档。',
    }));

  const linkRows = slice(0, 4);
  const manualRows = slice(4, 3);
  const retryRows = slice(7, 3);

  return [
    {
      key: 'refresh_link',
      title: '链接已失效',
      count: linkRows.length,
      action: 'refresh_link',
      description: '发票链接已过期，需要重新获取。',
      category: '链接失效',
      userMessage: '发票链接已过期，需要重新获取。',
      nextStep: '打开原始邮件，按邮件里的入口重新下载。',
      total: linkRows.length,
      rows: linkRows,
    },
    {
      key: 'manual_archive',
      title: '需要手动归档',
      count: manualRows.length,
      action: 'manual_archive',
      description: '这些邮件里的发票只能手动下载。',
      category: '手动归档',
      userMessage: '这些邮件里的发票只能手动下载。',
      nextStep: '下载后选择文件归档。',
      total: manualRows.length,
      rows: manualRows,
    },
    {
      key: 'retry',
      title: '可以重试',
      count: retryRows.length,
      action: 'retry',
      description: '上次网络中断，重试通常可以取到。',
      category: '网络中断',
      userMessage: '上次网络中断，重试通常可以取到。',
      nextStep: '重试获取发票文件。',
      total: retryRows.length,
      rows: retryRows,
    },
  ];
}

function buildHistory(): RunHistoryEntry[] {
  const raw: [string, string, RunHistoryEntry['status'], string, number][] = [
    ['fetch', '获取邮件', 'success', '新增 18 封邮件', 42600],
    ['pipeline', '获取发票文件', 'success', '新增 12 份发票', 128400],
    ['ocr', '识别发票', 'partial', '识别 12 份，3 份信息不完整', 96300],
    ['organize', '整理归档', 'success', '整理 124 份文件', 8200],
    ['fetch', '获取邮件', 'success', '新增 6 封邮件', 21800],
    ['pipeline', '获取发票文件', 'failed', '4 封邮件进入待确认', 74100],
  ];
  return raw.map(([action, title, status, message, durationMs], i) => ({
    id: `h${i + 1}`,
    time: dayStamp(i, 20 - i, (i * 17) % 60),
    action,
    title,
    status,
    message,
    detail: status === 'failed' ? '下载链接返回 403，已记录到待确认队列。' : '',
    durationMs,
  }));
}

const INBOX_ROWS = buildInbox();
const LIBRARY_ROWS = buildLibrary(INBOX_ROWS);
const PENDING_GROUPS = buildPending(INBOX_ROWS);
const HISTORY = buildHistory();

function countBy<T>(rows: T[], fn: (row: T) => boolean): number {
  return rows.reduce((n, row) => (fn(row) ? n + 1 : n), 0);
}

function buildSummary(): AppSummary {
  const statusCounts = {
    完整: countBy(LIBRARY_ROWS, (r) => r.status === '完整'),
    信息不完整: countBy(LIBRARY_ROWS, (r) => r.status === '信息不完整'),
    已归档: countBy(LIBRARY_ROWS, (r) => r.status === '已归档'),
    识别失败: countBy(LIBRARY_ROWS, (r) => r.status === '识别失败'),
  } as Record<LibraryStatus, number>;
  const duplicateRows = countBy(LIBRARY_ROWS, (r) => r.duplicateCount > 0);

  return {
    configPath: '~/Library/Application Support/发票助手/config.json',
    configExists: true,
    configError: '',
    history: HISTORY,
    inbox: {
      indexCsv: '~/发票助手/samples/raw/INDEX.csv',
      total: INBOX_ROWS.length,
      withAttachment: countBy(INBOX_ROWS, (r) => r.hasAttachment),
      withLinks: countBy(INBOX_ROWS, (r) => r.bodyLinkCount > 0),
      earliestMonth: '2026-06',
      latestMonth: '2026-09',
      rows: INBOX_ROWS,
      offset: 0,
      limit: INBOX_ROWS.length,
    },
    library: {
      pendingCsv: '~/发票助手/invoices/ocr/ocr-pending.csv',
      resultsCsv: '~/发票助手/invoices/ocr/ocr-results.csv',
      total: LIBRARY_ROWS.length,
      recognized: statusCounts['完整'],
      failed: statusCounts['识别失败'],
      ignored: statusCounts['已归档'],
      pending: statusCounts['信息不完整'],
      invoiceLike: countBy(LIBRARY_ROWS, (r) => r.documentType === '增值税电子普通发票'),
      itinerary: countBy(LIBRARY_ROWS, (r) => r.documentType.includes('行程单')),
      supporting: countBy(LIBRARY_ROWS, (r) => r.documentType === '支撑材料'),
      rows: LIBRARY_ROWS,
      offset: 0,
      limit: LIBRARY_ROWS.length,
      statusCounts,
      duplicates: { groups: 4, rows: duplicateRows },
      ocr: {
        pendingCsv: '~/发票助手/invoices/ocr/ocr-pending.csv',
        resultsCsv: '~/发票助手/invoices/ocr/ocr-results.csv',
        total: LIBRARY_ROWS.length,
        recognized: statusCounts['完整'],
        failed: statusCounts['识别失败'],
        partial: statusCounts['信息不完整'],
        ignored: statusCounts['已归档'],
        pending: 0,
        byDocumentType: DOC_TYPES.map((key) => ({
          key,
          count: countBy(LIBRARY_ROWS, (r) => r.documentType === key),
          examples: [],
        })),
        bySupportingReason: [],
        byFailureReason: [{ key: '识别服务返回空结果', count: statusCounts['识别失败'], examples: [] }],
      },
    },
    pending: {
      csvPath: '~/发票助手/pending/pending.csv',
      total: PENDING_GROUPS.reduce((n, g) => n + g.count, 0),
      groups: PENDING_GROUPS,
    },
  };
}

const CONFIG: ConfigPayload = {
  configPath: '~/Library/Application Support/发票助手/config.json',
  configExists: true,
  configError: '',
  config: {
    schemaVersion: 3,
    imap: { host: 'imap.qq.com', port: 993, user: 'demo@example.com', pass: '', tls: true, mailbox: ['INBOX'] },
    filter: {
      keywords: ['发票', '行程单', 'invoice'],
      matchSubject: true,
      matchBody: true,
      sinceDays: 30,
      since: undefined,
      until: undefined,
    },
    paths: { samples: './samples', invoices: './invoices', pending: './pending' },
    output: { csv: './invoices.csv' },
    rename: {
      avoidConflictBeforeOcr: true,
      rule: '{date}-{seller}-{amount}',
      fallback: '{date}-{filename}',
      applyAfterOcr: true,
      organizeByType: true,
      typeDirRule: '{documentType}',
      organizedDir: './organized',
    },
    ocr: {
      enabled: true,
      provider: 'efapiao',
      binaryPath: 'auto',
      ocrMode: 'auto',
      executionMode: 'auto',
      serviceUrl: '',
      serviceHost: '127.0.0.1',
      servicePort: 8000,
      serviceWorkers: 1,
      serviceStartupMs: 30000,
      batchSize: 16,
      timeoutMs: 60000,
      resultsCsv: './invoices/ocr/ocr-results.csv',
      credentials: {},
    },
    playwright: { headless: true, timeoutMs: 45000 },
    network: { retries: 2, retryDelayMs: 1500, timeoutMs: 30000 },
  },
  secrets: { imapPass: true, tencentSecretId: false, tencentSecretKey: false, ocrApiKey: false },
  dataDir: '~/发票助手',
};

// ---------------------------------------------------------------------------
// 事件模拟
// ---------------------------------------------------------------------------

type Cb<T> = (data: T) => void;

export function createFakeBridge(): MfhBridge {
  let fetchCb: Cb<FetchProgress> | null = null;
  let opCb: Cb<OperationProgress> | null = null;
  let fileCb: Cb<FileProgress> | null = null;
  let opStateCb: Cb<OpState> | null = null;
  let running: RunningOp | null = null;
  let stopRequested = false;

  function setRunning(next: RunningOp | null): void {
    running = next;
    opStateCb?.({ running: next });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 跑一段带进度的假任务；step 返回每一帧的事件。 */
  async function simulate<T>(
    kind: RunningOp['kind'],
    frames: T[],
    send: (frame: T) => void,
    frameMs = 260,
  ): Promise<void> {
    setRunning({ kind, jobId: `job-${Date.now()}`, startedAt: Date.now() });
    stopRequested = false;
    for (const frame of frames) {
      if (stopRequested) break;
      send(frame);
      await sleep(frameMs);
    }
    setRunning(null);
  }

  const bridge: MfhBridge = {
    async getSummary() {
      await sleep(60);
      return buildSummary();
    },
    async getConfig() {
      await sleep(40);
      return JSON.parse(JSON.stringify(CONFIG)) as ConfigPayload;
    },
    async saveConfig(): Promise<SaveConfigResult> {
      await sleep(120);
      return { ok: true, configPath: CONFIG.configPath, message: '已保存到本机。' };
    },

    async startFetch(payload: StartFetchPayload): Promise<TerminalResult> {
      const frames: FetchProgress[] = [
        { step: 'connect', percent: 8, message: '正在连接邮箱', kind: 'info', done: false },
        { step: 'search', percent: 26, matched: 24, message: '匹配到 24 封邮件', kind: 'info', done: false },
        { step: 'download', percent: 58, matched: 24, saved: 12, message: '已保存 12 封', kind: 'info', done: false },
        {
          step: 'download',
          percent: 86,
          matched: 24,
          saved: 18,
          skipped: 6,
          message: '已保存 18 封',
          kind: 'info',
          done: false,
        },
        {
          step: 'done',
          percent: 100,
          matched: 24,
          saved: 18,
          skipped: 6,
          message: payload.dryRun ? '试运行完成，未下载邮件' : '已完成，新增 18 封邮件',
          kind: 'success',
          done: true,
        },
      ];
      await simulate('fetch', frames, (f) => fetchCb?.(f));
      return {
        ok: true,
        status: 'success',
        started: true,
        jobId: 'fake-fetch',
        message: payload.dryRun ? '试运行完成，未下载邮件。' : '已完成，新增 18 封邮件。',
        summary: buildSummary(),
        normalizedFilter: { matchSubject: payload.matchSubject, matchBody: payload.matchBody },
        batch: {
          total: 18,
          rows: INBOX_ROWS.slice(0, 18).map((row) => ({
            mailHash: row.mailHash,
            messageId: row.messageId,
            date: row.date,
            from: row.from,
            subject: row.subject,
            hasAttachment: row.hasAttachment,
            bodyLinkCount: row.bodyLinkCount,
          })),
        },
      };
    },

    async runPipeline(): Promise<TerminalResult> {
      const frames: FileProgress[] = [
        { operation: 'files', phase: 'scan', percent: 12, message: '正在扫描邮件', kind: 'info', done: false },
        {
          operation: 'files',
          phase: 'download',
          percent: 48,
          processed: 6,
          message: '已取回 6 份',
          kind: 'info',
          done: false,
        },
        {
          operation: 'files',
          phase: 'download',
          percent: 82,
          processed: 12,
          skipped: 2,
          message: '已取回 12 份',
          kind: 'info',
          done: false,
        },
        {
          operation: 'files',
          phase: 'done',
          percent: 100,
          processed: 12,
          skipped: 2,
          failed: 1,
          message: '已完成，新增 12 份发票',
          kind: 'success',
          done: true,
        },
      ];
      await simulate('pipeline', frames, (f) => fileCb?.(f));
      return {
        ok: true,
        status: 'success',
        started: true,
        message: '已完成，新增 12 份发票。',
        summary: buildSummary(),
        batch: { total: 12, rows: [] },
      };
    },

    async runOcr(): Promise<TerminalResult> {
      const frames: OperationProgress[] = [
        {
          operation: 'ocr',
          phase: 'queue',
          percent: 10,
          total: 15,
          message: '队列中 15 份文件',
          kind: 'info',
          done: false,
        },
        {
          operation: 'ocr',
          phase: 'recognize',
          percent: 46,
          total: 15,
          processed: 7,
          parsed: 6,
          message: '已识别 7 份',
          kind: 'info',
          done: false,
        },
        {
          operation: 'ocr',
          phase: 'recognize',
          percent: 88,
          total: 15,
          processed: 13,
          parsed: 12,
          message: '已识别 13 份',
          kind: 'info',
          done: false,
        },
        {
          operation: 'ocr',
          phase: 'done',
          percent: 100,
          total: 15,
          processed: 15,
          parsed: 12,
          skipped: 2,
          failed: 1,
          message: '已完成，识别 12 份，3 份信息不完整',
          kind: 'success',
          done: true,
        },
      ];
      await simulate('ocr', frames, (f) => opCb?.(f));
      return { ok: true, status: 'partial', started: true, message: '识别 12 份，3 份信息不完整。', summary: buildSummary() };
    },

    async stopOcr(): Promise<BaseResult> {
      if (!running) return { ok: false, code: 'ocr_not_running', message: '当前没有正在运行的识别任务。' };
      stopRequested = true;
      return { ok: true, code: 'ocr_stopping', message: '正在停止识别。' };
    },

    async organize(): Promise<OrganizeResult> {
      await sleep(400);
      return {
        ok: true,
        status: 'success',
        message: '已整理 124 份文件。',
        counts: { scanned: 124, copied: 124, skipped: 0, failed: 0 },
        summary: buildSummary(),
      };
    },

    async openPath(): Promise<OpenResult> {
      await sleep(80);
      return { ok: true, code: 'preview_only', message: '预览模式不会调用本机程序。' };
    },
    async copyText(payload): Promise<BaseResult> {
      try {
        await navigator.clipboard.writeText(payload.text);
      } catch {
        // 预览模式下剪贴板可能不可用，忽略即可。
      }
      return { ok: true };
    },

    async getOpState(): Promise<OpState> {
      return { running };
    },
    async getAppInfo(): Promise<AppInfo> {
      return {
        version: '0.0.7',
        channel: 'development',
        packaged: false,
        platform: 'darwin',
        arch: 'arm64',
        electron: '42.2.0',
      };
    },

    async testMailConnection(): Promise<TestConnectionResult> {
      await sleep(500);
      return { ok: true, code: 'imap_ok', message: '邮箱连接正常。' };
    },
    async listMailboxes(): Promise<ListMailboxesResult> {
      await sleep(300);
      return { ok: true, mailboxes: ['INBOX', 'Sent Messages', 'Archive', '发票'] };
    },

    async pendingIgnore(): Promise<PendingIgnoreResult> {
      await sleep(120);
      return { ok: true, code: 'pending_ignored', message: '已移出待确认。', removed: 1, summary: buildSummary() };
    },
    async pendingRefreshLink(): Promise<OpenMailResult> {
      await sleep(120);
      return { ok: true, opened: 'mail', code: 'preview_only', message: '预览模式不会调用本机程序。' };
    },
    async pendingManualArchive(): Promise<PendingManualArchiveResult> {
      await sleep(200);
      return { ok: true, canceled: true, code: 'preview_only', message: '预览模式不会打开文件选择框。' };
    },

    async developerReset(): Promise<DeveloperResetResult> {
      await sleep(300);
      return { ok: true, removed: ['samples', 'invoices', 'pending'], skippedExternal: [], message: '已重置应用数据。' };
    },
    async archiveJournalStatus(): Promise<ArchiveJournalStatus> {
      return { ok: true, code: 'journal_clear', status: 'clear', residualCount: 0, message: '归档记录正常。' };
    },
    async archiveJournalQuarantine(): Promise<BaseResult> {
      return { ok: true, message: '没有需要隔离的记录。' };
    },

    onFetchProgress(cb) {
      fetchCb = cb;
    },
    onOperationProgress(cb) {
      opCb = cb;
    },
    onFileProgress(cb) {
      fileCb = cb;
    },
    onOpState(cb) {
      opStateCb = cb;
      cb({ running });
    },

    async mailDetail(payload): Promise<MailDetailResult> {
      await sleep(120);
      const mail = INBOX_ROWS.find((row) => row.mailHash === payload.hash);
      if (!mail) return { ok: false, code: 'mail_not_found', message: '找不到这封邮件。' };
      const documents = LIBRARY_ROWS.filter((row) => row.mailHash === mail.mailHash);
      return {
        ok: true,
        mail: {
          ...mail,
          emlExists: mail.mailOpenable,
          emlLocation: mail.status === 'pending' ? 'pending' : 'samples',
          attachments: mail.hasAttachment
            ? [{ filename: '电子发票.pdf', size: 184320, contentType: 'application/pdf' }]
            : [],
          links: Array.from({ length: Math.min(mail.bodyLinkCount, 3) }, (_, i) => ({
            url: `https://invoice.example.com/download/${mail.mailHash}/${i + 1}`,
            label: `下载发票 ${i + 1}`,
          })),
          documents,
          pending:
            mail.status === 'pending'
              ? {
                  reason: 'download_failed',
                  category: '链接失效',
                  userMessage: '发票链接已过期。',
                  nextStep: '打开原始邮件重新下载。',
                }
              : null,
          history: [{ time: mail.date, action: 'fetch', status: 'success', message: '已保存原始邮件' }],
        },
      };
    },

    async openMail(): Promise<OpenMailResult> {
      await sleep(120);
      return { ok: true, opened: 'mail', code: 'preview_only', message: '预览模式不会调用本机程序。' };
    },

    async invoiceDetail(payload): Promise<InvoiceDetailResult> {
      await sleep(120);
      const row = LIBRARY_ROWS.find((r) => r.filename === payload.filename);
      if (!row) return { ok: false, code: 'invoice_not_found', message: '找不到这份发票。' };
      return {
        ok: true,
        invoice: {
          row,
          ocr: row.status === '完整'
            ? {
                documentType: row.documentType,
                invoiceType: row.invoiceType,
                seller: row.seller,
                amount: row.amount,
                dateValue: row.date,
                invoiceNo: row.invoiceNo,
                transport: '',
                extractedBy: 'efapiao',
                parserVersion: '0.1.3',
                ocrVendor: 'efapiao',
                status: 'success',
                error: '',
              }
            : null,
          ledger: {
            messageId: row.messageId,
            date: row.date,
            from: row.from,
            subject: row.subject,
            source: 'attachment',
            mailHash: row.mailHash,
            contentHash: row.contentHash,
          },
          file: { handle: row.fileHandle, exists: true, size: 187654, format: row.filename.split('.').pop() ?? 'pdf' },
          duplicates: row.duplicateGroup
            ? LIBRARY_ROWS.filter((r) => r.duplicateGroup === row.duplicateGroup && r.filename !== row.filename)
            : [],
        },
      };
    },

    async dedupe(payload: DedupePayload): Promise<DedupeResult> {
      await sleep(600);
      const groups = LIBRARY_ROWS.filter((r) => r.duplicateCount > 0 && r.duplicateGroup);
      const seen = new Set<string>();
      const report = {
        mode: payload.by,
        applied: payload.apply,
        quarantineDir: payload.apply ? 'invoices/.dedupe-quarantine/20260905-0900/by-invoice-no' : null,
        pairs: 4,
        redundant: 4,
        quarantined: payload.apply ? 4 : 0,
        ledgerRowsRemoved: payload.apply ? 4 : 0,
        ocrRowsRemoved: payload.apply ? 4 : 0,
        conflicts: 0,
        skipped: [],
        groups: groups.flatMap((row) => {
          if (seen.has(row.duplicateGroup)) return [];
          seen.add(row.duplicateGroup);
          const members = LIBRARY_ROWS.filter((r) => r.duplicateGroup === row.duplicateGroup);
          const [kept, ...removed] = members;
          if (!kept) return [];
          return [
            {
              invoiceNo: row.duplicateGroup,
              kept: {
                filename: kept.filename,
                date: kept.date,
                seller: kept.seller,
                amount: kept.amount,
                format: kept.filename.split('.').pop() ?? 'pdf',
              },
              removed: removed.map((r) => ({
                filename: r.filename,
                date: r.date,
                seller: r.seller,
                amount: r.amount,
                format: r.filename.split('.').pop() ?? 'pdf',
                reason: 'same_invoice_no',
              })),
              conflict: false,
              conflictReason: '',
            },
          ];
        }),
      };
      return {
        ok: true,
        status: 'success',
        message: payload.apply ? '已隔离 4 份重复发票。' : '发现 4 组重复发票。',
        report,
        summary: buildSummary(),
      };
    },
  };

  return bridge;
}
