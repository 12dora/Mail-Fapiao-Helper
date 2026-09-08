/**
 * 浏览器预览用的假数据集。
 *
 * 三种形态，用 `?fake=<变体>` 选：
 * - `1` / 空：正常的一屏数据，截图用的就是它；
 * - `empty`：邮件、发票、待确认都为空，用来看空状态；
 * - `broken`：配置文件损坏 + 密钥都已保存 + 保存时报字段错误。
 *
 * 数据形状与真实 IPC 完全一致——改 types.ts 时这里也要跟着改，否则页面作者会
 * 对着不存在的字段写界面。生成过程是确定性的，同一次构建的截图可复现。
 */
import type {
  AppSummary,
  ConfigPayload,
  InboxRow,
  InboxStatus,
  InvoiceRow,
  LibraryStatus,
  MailAttachment,
  PendingGroup,
  PendingRow,
  RunHistoryEntry,
} from '../types.js';

export type FakeVariant = 'demo' | 'empty' | 'broken';

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

/** documentType 与 invoiceType 成对出现，覆盖界面上所有的类型名。 */
export const DOC_KINDS = [
  { documentType: 'invoice', invoiceType: 'digital_normal_invoice' },
  { documentType: 'invoice', invoiceType: 'digital_special_invoice' },
  { documentType: 'invoice', invoiceType: '增值税普通发票' },
  { documentType: 'itinerary', invoiceType: '航空运输电子客票行程单' },
  { documentType: 'invoice', invoiceType: 'train_ticket' },
  { documentType: 'supporting', invoiceType: 'settlement' },
] as const;

/** 附件的大小与类型都要有落差：几百字节到几 MB，PDF / OFD / 图片 / 表格都有。 */
const ATTACHMENTS: MailAttachment[] = [
  { filename: '电子发票.pdf', size: 184320, contentType: 'application/pdf' },
  { filename: '行程单.ofd', size: 26214, contentType: 'application/ofd' },
  { filename: '发票照片.jpg', size: 1572864, contentType: 'image/jpeg' },
  { filename: '费用结算单.pdf', size: 943, contentType: 'application/pdf' },
  {
    filename: '账单明细.xlsx',
    size: 5242880,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
];

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
// 邮件
// ---------------------------------------------------------------------------

const INBOX_STATUSES: InboxStatus[] = ['archived', 'archived', 'archived', 'pending', 'unprocessed', 'ignored'];

/** 这封邮件的 .eml 读得到文件、读不出内容：详情接口回 eml_unreadable。 */
export const UNREADABLE_INDEX = 8;
/** 这封邮件从未落盘：列表和详情都要显示成打不开。 */
export const MISSING_EML_INDEX = 2;

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
      mailOpenable: status !== 'unprocessed' && i !== MISSING_EML_INDEX,
    });
  }
  return rows;
}

/** 邮件详情里的附件：按索引取 0～3 个，大小与类型各不相同。 */
export function attachmentsFor(index: number, hasAttachment: boolean): MailAttachment[] {
  if (!hasAttachment) return [];
  const count = 1 + (index % 3);
  return Array.from({ length: count }, (_, n) => ATTACHMENTS[(index + n) % ATTACHMENTS.length] as MailAttachment);
}

// ---------------------------------------------------------------------------
// 发票库
// ---------------------------------------------------------------------------

const LIBRARY_STATUSES: LibraryStatus[] = ['完整', '完整', '完整', '完整', '信息不完整', '已归档', '识别失败'];

/**
 * 20 位发票号。用字符串拼，不做大整数加法——超过 2^53 的字面量会被浮点截断，
 * 相邻几行会拿到同一个号，界面上凭空多出「重复」。
 */
function invoiceNumber(index: number): string {
  return `24312${String(1000000 + index * 17).padStart(15, '0')}`;
}

/** 同号重复对：前一行保留，后一行是多出来的那份。 */
export const DUPLICATE_PAIRS: readonly (readonly [number, number])[] = [
  [3, 61],
  [10, 74],
  [17, 88],
  [24, 101],
];
/** 这一组金额对不上，去重时只报冲突、不动文件。 */
export const CONFLICT_PAIR: readonly [number, number] = [10, 74];

function buildLibrary(inbox: InboxRow[]): InvoiceRow[] {
  const rng = makeRng(864213);
  const rows: InvoiceRow[] = [];
  for (let i = 0; i < 124; i++) {
    const status = LIBRARY_STATUSES[i % LIBRARY_STATUSES.length] as LibraryStatus;
    const mail = inbox[i % inbox.length] as InboxRow;
    const kind = DOC_KINDS[i % DOC_KINDS.length] as (typeof DOC_KINDS)[number];
    const complete = status === '完整';
    const supporting = kind.documentType === 'supporting';
    const format = i % 6 === 0 ? 'ofd' : 'pdf';
    const name = `${dateOnly(Math.floor(i * 0.4))}-${1000 + i}.${format}`;
    rows.push({
      date: dateOnly(Math.floor(i * 0.4)),
      seller: complete ? pick(rng, SELLERS) : '',
      invoiceNo: complete && !supporting ? invoiceNumber(i) : '',
      amount: complete && !supporting ? (12 + rng() * 4200).toFixed(2) : '',
      source: i % 3 === 0 ? '附件' : 'https://invoice.example.com/download',
      filename: name,
      filePath: `invoices/${name}`,
      fileHandle: `invoices/${name}`,
      status,
      documentType: kind.documentType,
      invoiceType: complete ? kind.invoiceType : '',
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

  for (const [keep, dup] of DUPLICATE_PAIRS) {
    const a = rows[keep];
    const b = rows[dup];
    if (!a || !b || !a.invoiceNo) continue;
    b.invoiceNo = a.invoiceNo;
    b.seller = a.seller;
    // 冲突组故意让金额对不上，其余组两份完全一致。
    b.amount = keep === CONFLICT_PAIR[0] ? `${Number(a.amount) + 30}.00` : a.amount;
    b.status = '完整';
    b.documentType = a.documentType;
    b.invoiceType = a.invoiceType;
    for (const row of [a, b]) {
      row.duplicateGroup = a.invoiceNo;
      row.duplicateCount = 2;
    }
  }
  return rows;
}

/**
 * 预览模式下的「仅重试失败项」：把识别失败的行翻成完整，其余行原样留着。
 *
 * 真机上这是主进程重跑一遍 OCR 之后的结果，这里直接把结果摆出来——重点是让界面
 * 能看到「成功的没被清掉、失败的补上了」这件事。返回补上的份数。
 *
 * 换掉整个数组、也换掉改过的那些行对象，不在原对象上改字段：真实 IPC 每次回的
 * 都是新对象，页面的筛选结果是按引用记忆的，原地改字段界面不会跟着变。
 */
export function retryFailedRows(variant: FakeVariant): number {
  const rng = makeRng(778899);
  const data = dataset(variant);
  let fixed = 0;
  data.library = data.library.map((row, index) => {
    if (row.status !== '识别失败') return row;
    const kind = DOC_KINDS[index % DOC_KINDS.length] as (typeof DOC_KINDS)[number];
    fixed++;
    return {
      ...row,
      status: '完整',
      error: '',
      seller: pick(rng, SELLERS),
      invoiceType: kind.invoiceType,
      // 附属材料本来就没有发票号和金额，补上反而与其余附属材料对不上。
      invoiceNo: kind.documentType === 'supporting' ? row.invoiceNo : invoiceNumber(index),
      amount: kind.documentType === 'supporting' ? row.amount : (12 + rng() * 4200).toFixed(2),
    };
  });
  return fixed;
}

// ---------------------------------------------------------------------------
// 待确认
// ---------------------------------------------------------------------------

interface GroupCopy {
  key: string;
  title: string;
  action: PendingGroup['action'];
  reason: string;
  category: string;
  userMessage: string;
  nextStep: string;
}

const GROUP_COPY: GroupCopy[] = [
  {
    key: 'refresh_link',
    title: '链接已失效',
    action: 'refresh_link',
    reason: 'link_expired',
    category: '链接失效',
    userMessage: '发票链接已过期，需要重新获取。',
    nextStep: '打开原始邮件，按邮件里的入口重新下载。',
  },
  {
    key: 'manual_archive',
    title: '需要手动归档',
    action: 'manual_archive',
    reason: 'manual_download_only',
    category: '手动归档',
    userMessage: '这些邮件里的发票只能手动下载。',
    nextStep: '下载后选择文件归档。',
  },
  {
    key: 'retry',
    title: '可以重试',
    action: 'retry',
    reason: 'network_error',
    category: '网络中断',
    userMessage: '上次网络中断，重试通常可以取到。',
    nextStep: '重试获取发票文件。',
  },
];

function buildPending(inbox: InboxRow[]): PendingGroup[] {
  const candidates = inbox.filter((row) => row.status === 'pending');
  const sizes = [4, 3, 3];
  let cursor = 0;
  return GROUP_COPY.map((copy, index) => {
    const count = sizes[index] ?? 0;
    // 每一行都带上自己那一组的文案：抽屉在 mailDetail 到手之前就得说清原因。
    const rows: PendingRow[] = candidates.slice(cursor, cursor + count).map((row) => ({
      hash: row.mailHash,
      messageId: row.messageId,
      date: row.date,
      from: row.from,
      subject: row.subject,
      reason: copy.reason,
      machineReason: copy.reason,
      category: copy.category,
      userMessage: copy.userMessage,
      nextStep: copy.nextStep,
    }));
    cursor += count;
    return {
      key: copy.key,
      title: copy.title,
      count: rows.length,
      action: copy.action,
      description: copy.userMessage,
      category: copy.category,
      userMessage: copy.userMessage,
      nextStep: copy.nextStep,
      total: rows.length,
      rows,
    };
  });
}

// ---------------------------------------------------------------------------
// 运行历史
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface FakeDataset {
  inbox: InboxRow[];
  library: InvoiceRow[];
  pending: PendingGroup[];
  history: RunHistoryEntry[];
}

function countBy<T>(rows: T[], fn: (row: T) => boolean): number {
  return rows.reduce((n, row) => (fn(row) ? n + 1 : n), 0);
}

function buildDataset(variant: FakeVariant): FakeDataset {
  if (variant === 'empty') return { inbox: [], library: [], pending: [], history: [] };
  const inbox = buildInbox();
  return { inbox, library: buildLibrary(inbox), pending: buildPending(inbox), history: buildHistory() };
}

const DATASETS = new Map<FakeVariant, FakeDataset>();

export function dataset(variant: FakeVariant): FakeDataset {
  const cached = DATASETS.get(variant);
  if (cached) return cached;
  const built = buildDataset(variant);
  DATASETS.set(variant, built);
  return built;
}

export function buildSummary(variant: FakeVariant): AppSummary {
  const { inbox, library, pending, history } = dataset(variant);
  const statusCounts = {
    完整: countBy(library, (r) => r.status === '完整'),
    信息不完整: countBy(library, (r) => r.status === '信息不完整'),
    已归档: countBy(library, (r) => r.status === '已归档'),
    识别失败: countBy(library, (r) => r.status === '识别失败'),
  } as Record<LibraryStatus, number>;
  // 同号组数从行里数出来：附属材料没有发票号，配对时会被跳过，不能直接用对子数。
  const duplicateGroups = new Set(library.filter((r) => r.duplicateGroup).map((r) => r.duplicateGroup));
  const duplicateRows = countBy(library, (r) => r.duplicateCount > 0);
  const supporting = countBy(library, (r) => r.documentType === 'supporting');

  return {
    configPath: '~/Library/Application Support/发票助手/config.json',
    configExists: variant !== 'broken',
    configError: variant === 'broken' ? '配置文件不是合法的 JSON，第 12 行附近有多余的逗号。' : '',
    history,
    inbox: {
      indexCsv: '~/发票助手/samples/raw/INDEX.csv',
      total: inbox.length,
      withAttachment: countBy(inbox, (r) => r.hasAttachment),
      withLinks: countBy(inbox, (r) => r.bodyLinkCount > 0),
      earliestMonth: inbox.length ? '2026-06' : '',
      latestMonth: inbox.length ? '2026-09' : '',
      rows: inbox,
      offset: 0,
      limit: inbox.length,
    },
    library: {
      pendingCsv: '~/发票助手/invoices/ocr/ocr-pending.csv',
      resultsCsv: '~/发票助手/invoices/ocr/ocr-results.csv',
      total: library.length,
      recognized: statusCounts['完整'],
      failed: statusCounts['识别失败'],
      ignored: statusCounts['已归档'],
      pending: statusCounts['信息不完整'],
      invoiceLike: countBy(library, (r) => r.documentType === 'invoice'),
      itinerary: countBy(library, (r) => r.documentType === 'itinerary'),
      supporting,
      rows: library,
      offset: 0,
      limit: library.length,
      statusCounts,
      duplicates: { groups: duplicateGroups.size, rows: duplicateRows },
      ocr: {
        pendingCsv: '~/发票助手/invoices/ocr/ocr-pending.csv',
        resultsCsv: '~/发票助手/invoices/ocr/ocr-results.csv',
        total: library.length,
        recognized: statusCounts['完整'],
        failed: statusCounts['识别失败'],
        partial: statusCounts['信息不完整'],
        ignored: statusCounts['已归档'],
        pending: 0,
        byDocumentType: ['invoice', 'itinerary', 'supporting'].map((key) => ({
          key,
          count: countBy(library, (r) => r.documentType === key),
          examples: [],
        })),
        bySupportingReason: supporting ? [{ key: 'settlement', count: supporting, examples: [] }] : [],
        byFailureReason: statusCounts['识别失败']
          ? [{ key: '识别服务返回空结果', count: statusCounts['识别失败'], examples: [] }]
          : [],
      },
    },
    pending: {
      csvPath: '~/发票助手/pending/pending.csv',
      total: pending.reduce((n, g) => n + g.count, 0),
      groups: pending,
    },
  };
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

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

export function configFor(variant: FakeVariant): ConfigPayload {
  const copy = JSON.parse(JSON.stringify(CONFIG)) as ConfigPayload;
  if (variant !== 'broken') return copy;
  copy.configExists = true;
  copy.configError = '配置文件不是合法的 JSON，第 12 行附近有多余的逗号。';
  copy.configErrorInfo = { message: '配置文件不是合法的 JSON。', detail: '第 12 行附近有多余的逗号。' };
  copy.secrets = { imapPass: true, tencentSecretId: true, tencentSecretKey: true, ocrApiKey: true };
  return copy;
}
