/**
 * `window.mfhBridge` 的完整类型定义。
 *
 * 与主进程的对应关系：
 * - 请求/响应通道见 src/electron/ipc/*Handlers.ts（全部经过 handleTrusted）
 * - 事件通道见 src/electron/rendererEvents.ts
 *
 * 这里只描述形状，不做任何运行时逻辑；新增字段请同步 docs 里的 IPC 契约。
 */

// ---------------------------------------------------------------------------
// 基础信封
// ---------------------------------------------------------------------------

/** 所有 IPC 返回值的公共部分。 */
export interface BaseResult {
  ok: boolean;
  code?: string;
  message?: string;
  detail?: string;
  error?: string;
}

/** 长任务（fetch / pipeline / ocr / organize / dedupe）的终态信封。 */
export interface TerminalResult extends BaseResult {
  status?: 'success' | 'partial' | 'failed';
  started?: boolean;
  jobId?: string;
  summary?: AppSummary;
  batch?: BatchResult;
  normalizedFilter?: NormalizedFilter;
}

export interface BatchResult {
  rows: BatchRow[];
  total: number;
}

export interface BatchRow {
  mailHash?: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  hasAttachment?: boolean;
  bodyLinkCount?: number;
}

export interface NormalizedFilter {
  matchSubject: boolean;
  matchBody: boolean;
  changed?: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// 汇总数据（mfh:get-summary）
// ---------------------------------------------------------------------------

/** 发票库状态枚举，值与 src/electron/summary.ts 的 LIBRARY_STATUS 一致。 */
export type LibraryStatus = '完整' | '信息不完整' | '已归档' | '识别失败';

export const LIBRARY_STATUS_VALUES: readonly LibraryStatus[] = ['完整', '信息不完整', '已归档', '识别失败'];

/** 邮件在处理流水线中的位置。 */
export type InboxStatus = 'archived' | 'pending' | 'unprocessed' | 'ignored';

export interface InboxRow {
  mailHash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  mailbox: string;
  hasAttachment: boolean;
  bodyLinkCount: number;
  /** archived=已产出台账行；pending=在待确认队列；ignored=处理过但无产出；unprocessed=只抓取未处理。 */
  status: InboxStatus;
  /** 这封邮件产出的台账行数。 */
  documentCount: number;
  /** samples/raw 或 pending 下存在 .eml，可以打开原始邮件。 */
  mailOpenable: boolean;
}

export interface InboxSummary {
  indexCsv: string;
  total: number;
  withAttachment: number;
  withLinks: number;
  earliestMonth: string;
  latestMonth: string;
  rows: InboxRow[];
  offset: number;
  limit: number;
}

export interface InvoiceRow {
  date: string;
  seller: string;
  invoiceNo: string;
  amount: string;
  source: string;
  filename: string;
  /** dataDir 相对路径或 `ext:` 句柄，直接交给 openPath。 */
  filePath: string;
  /** 与 filePath 同值，语义上是「可以打开的句柄」。 */
  fileHandle: string;
  status: LibraryStatus;
  documentType: string;
  invoiceType: string;
  error: string;
  mailHash: string;
  messageId: string;
  from: string;
  subject: string;
  contentHash: string;
  /** 同号重复组的发票号；不重复时为空串。 */
  duplicateGroup: string;
  /** 重复组内行数；不重复时为 0。 */
  duplicateCount: number;
}

export interface OcrSummaryExample {
  hash: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  format: string;
  documentType: string;
  status: string;
  reason: string;
}

export interface OcrSummaryGroup {
  key: string;
  count: number;
  examples: OcrSummaryExample[];
}

export interface OcrSummary {
  pendingCsv: string;
  resultsCsv: string;
  total: number;
  recognized: number;
  failed: number;
  partial: number;
  ignored: number;
  pending: number;
  byDocumentType: OcrSummaryGroup[];
  bySupportingReason: OcrSummaryGroup[];
  byFailureReason: OcrSummaryGroup[];
}

export interface LibrarySummary {
  pendingCsv: string;
  resultsCsv: string;
  total: number;
  recognized: number;
  failed: number;
  ignored: number;
  pending: number;
  invoiceLike: number;
  itinerary: number;
  supporting: number;
  rows: InvoiceRow[];
  offset: number;
  limit: number;
  statusCounts: Record<LibraryStatus, number>;
  /** 全库同号重复统计（后端在全量行上计算，不只是当前页）。 */
  duplicates: { groups: number; rows: number };
  ocr: OcrSummary;
}

export type PendingAction = 'retry' | 'refresh_link' | 'manual_archive' | 'ignore';

export interface PendingRow {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  reason: string;
  machineReason: string;
  category: string;
  userMessage: string;
  nextStep: string;
}

export interface PendingGroup {
  key: string;
  title: string;
  count: number;
  action: PendingAction;
  description: string;
  category: string;
  userMessage: string;
  nextStep: string;
  total: number;
  rows: PendingRow[];
}

export interface PendingSummary {
  csvPath: string;
  total: number;
  groups: PendingGroup[];
}

export interface RunHistoryEntry {
  id: string;
  time: string;
  action: string;
  title: string;
  status: 'success' | 'partial' | 'failed';
  message: string;
  detail: string;
  durationMs: number;
}

export interface AppSummary {
  configPath: string;
  configExists: boolean;
  configError: string;
  history: RunHistoryEntry[];
  inbox: InboxSummary;
  library: LibrarySummary;
  pending: PendingSummary;
}

export interface SummaryQuery {
  inboxLimit?: number;
  inboxOffset?: number;
  libraryLimit?: number;
  libraryOffset?: number;
}

// ---------------------------------------------------------------------------
// 配置（mfh:get-config / mfh:save-config）
// ---------------------------------------------------------------------------

export interface AppConfig {
  schemaVersion: number;
  imap: { host: string; port: number; user: string; pass: string; tls: boolean; mailbox: string[] };
  filter: {
    keywords: string[];
    matchSubject: boolean;
    matchBody: boolean;
    sinceDays: number;
    since?: string;
    until?: string;
  };
  paths: { samples: string; invoices: string; pending: string };
  output: { csv: string };
  rename: {
    avoidConflictBeforeOcr: boolean;
    rule: string;
    fallback: string;
    applyAfterOcr: boolean;
    organizeByType: boolean;
    typeDirRule: string;
    organizedDir: string;
  };
  ocr: {
    enabled: boolean;
    provider: string;
    binaryPath: string;
    ocrMode: 'auto' | 'disabled' | 'required';
    executionMode: 'auto' | 'serve' | 'cli';
    serviceUrl: string;
    serviceHost: string;
    servicePort: number;
    serviceWorkers: number;
    serviceStartupMs: number;
    batchSize: number;
    timeoutMs: number;
    resultsCsv: string;
    credentials: Record<string, string>;
  };
  playwright: { headless: boolean; timeoutMs: number };
  network: { retries: number; retryDelayMs: number; timeoutMs: number };
}

/** 密钥永远不回传明文，只回传「是否已填写」。 */
export interface SecretPresence {
  imapPass: boolean;
  tencentSecretId: boolean;
  tencentSecretKey: boolean;
  ocrApiKey: boolean;
}

export interface ConfigFieldError {
  path: string;
  message: string;
}

export interface ConfigPayload {
  configPath: string;
  configExists: boolean;
  configError: string;
  configErrorInfo?: { code?: string; message?: string; detail?: string };
  config: AppConfig;
  secrets: SecretPresence;
  dataDir: string;
}

/**
 * 配置读写出错时的说明。
 * `mfh:get-config` 回的是一句话，`mfh:save-config` 回的是结构化对象；
 * 两个通道共用同一个字段名，所以类型是联合，渲染层统一用 errorText() 收敛成一句话。
 */
export type ConfigErrorInfo = {
  message?: string;
  detail?: string;
  backupPath?: string;
  backupCreated?: boolean;
};

export interface SaveConfigResult extends BaseResult {
  configPath?: string;
  configError?: string | ConfigErrorInfo;
  fieldErrors?: ConfigFieldError[];
}

/**
 * 保存时只提交改过的字段，结构与 AppConfig 一致的嵌套局部对象，
 * 例如 `{ imap: { host: 'imap.qq.com' } }`。
 * 顶层另外接受 `repairCorrupt: true`——损坏的配置文件另存备份后按默认值重建。
 */
export type ConfigDraft = Record<string, unknown> & { repairCorrupt?: boolean };

// ---------------------------------------------------------------------------
// 长任务入参
// ---------------------------------------------------------------------------

export interface StartFetchPayload {
  from: string;
  to: string;
  matchSubject: boolean;
  matchBody: boolean;
  dryRun: boolean;
}

export interface RunPipelinePayload {
  concurrency?: number;
  onlyMail?: string;
  pendingRetry?: boolean;
  avoidConflictBeforeOcr?: boolean;
  force?: boolean;
}

export interface RunOcrPayload {
  force?: boolean;
  resetResults?: boolean;
  concurrency?: number;
}

export interface OrganizePayload {
  applyRename?: boolean;
}

export interface OrganizeResult extends TerminalResult {
  scanned?: number;
  counts?: { scanned: number; copied: number; skipped: number; failed: number };
  warning?: string;
}

// ---------------------------------------------------------------------------
// 打开 / 揭示
// ---------------------------------------------------------------------------

export type OpenLocation = 'invoices' | 'pending' | 'samples' | 'organized' | 'dataDir' | 'ledger';

export type OpenPathPayload =
  | { location: OpenLocation; reveal?: boolean }
  | { handle: string; reveal?: boolean }
  | { path: string; reveal?: boolean };

export interface OpenResult extends BaseResult {
  revealed?: boolean;
  location?: string;
}

export interface OpenMailPayload {
  hash: string;
  reveal?: boolean;
}

export interface OpenMailResult extends BaseResult {
  opened?: 'mail' | 'folder' | 'reveal_attempted' | 'none';
}

/** 只允许项目地址与反馈入口两个地址，主进程按完整串比对。 */
export type ExternalUrl =
  | 'https://github.com/12dora/Mail-Fapiao-Helper'
  | 'https://github.com/12dora/Mail-Fapiao-Helper/issues';

export interface PickDirectoryPayload {
  title?: string;
  defaultPath?: string;
}

export interface PickDirectoryResult extends BaseResult {
  /** 原始绝对路径：渲染层原样送回 saveConfig，不能是脱敏展示串。 */
  path?: string;
  canceled?: boolean;
}

export interface ExportCsvPayload {
  filename: string;
  csv: string;
}

export interface ExportCsvResult extends BaseResult {
  /** 脱敏后的展示路径，只用来提示用户存到哪儿了。 */
  path?: string;
  canceled?: boolean;
}

// ---------------------------------------------------------------------------
// 详情（mfh:mail-detail / mfh:invoice-detail）
// ---------------------------------------------------------------------------

export interface MailAttachment {
  filename: string;
  size: number;
  contentType: string;
}

export interface MailLink {
  url: string;
  label: string;
}

export interface MailHistoryEntry {
  time: string;
  action: string;
  status: string;
  message: string;
}

export interface MailDetail {
  mailHash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  mailbox: string;
  hasAttachment: boolean;
  bodyLinkCount: number;
  status: InboxStatus;
  emlExists: boolean;
  emlLocation: 'samples' | 'pending' | null;
  attachments: MailAttachment[];
  links: MailLink[];
  documents: InvoiceRow[];
  pending: { reason: string; category: string; userMessage: string; nextStep: string } | null;
  history: MailHistoryEntry[];
}

export interface MailDetailResult extends BaseResult {
  mail?: MailDetail;
}

export interface OcrRecord {
  documentType: string;
  invoiceType: string;
  seller: string;
  amount: string;
  dateValue: string;
  invoiceNo: string;
  transport: string;
  extractedBy: string;
  parserVersion: string;
  ocrVendor: string;
  status: string;
  error: string;
}

export interface LedgerRecord {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  source: string;
  mailHash: string;
  contentHash: string;
}

export interface InvoiceDetail {
  row: InvoiceRow;
  ocr: OcrRecord | null;
  ledger: LedgerRecord | null;
  file: { handle: string; exists: boolean; size: number; format: string };
  duplicates: InvoiceRow[];
}

export interface InvoiceDetailResult extends BaseResult {
  invoice?: InvoiceDetail;
}

// ---------------------------------------------------------------------------
// 查重（mfh:dedupe）
// ---------------------------------------------------------------------------

export type DedupeMode = 'invoice-no' | 'container';

export interface DedupeMember {
  filename: string;
  date: string;
  seller: string;
  amount: string;
  format: string;
  reason?: string;
}

export interface DedupeGroup {
  invoiceNo: string;
  kept: DedupeMember;
  removed: DedupeMember[];
  conflict: boolean;
  conflictReason: string;
}

export interface DedupeReport {
  mode: DedupeMode;
  applied: boolean;
  quarantineDir: string | null;
  pairs: number;
  redundant: number;
  quarantined: number;
  ledgerRowsRemoved: number;
  ocrRowsRemoved: number;
  groups: DedupeGroup[];
  conflicts: number;
  skipped: { filename: string; reason: string }[];
}

export interface DedupePayload {
  by: DedupeMode;
  apply: boolean;
}

export interface DedupeResult extends TerminalResult {
  report?: DedupeReport | null;
}

// ---------------------------------------------------------------------------
// 邮箱 / 待确认 / 维护
// ---------------------------------------------------------------------------

export interface TestConnectionResult extends BaseResult {
  kind?: string;
}

export interface ListMailboxesResult extends BaseResult {
  mailboxes: string[];
}

export interface PendingIgnoreResult extends BaseResult {
  removed?: number;
  summary?: AppSummary;
}

export interface PendingManualArchiveResult extends BaseResult {
  canceled?: boolean;
  pendingRemoved?: number;
  summary?: AppSummary;
}

export interface DeveloperResetResult extends BaseResult {
  removed: string[];
  skippedExternal: string[];
  summary?: AppSummary;
}

export interface ArchiveJournalStatus extends BaseResult {
  status: 'clear' | 'residual' | 'unreadable';
  residualCount: number;
  parseableCount?: number;
  corruptCount?: number;
  blocked?: boolean;
  canQuarantine?: boolean;
}

export interface AppInfo {
  version: string;
  channel: string;
  packaged: boolean;
  platform: string;
  arch: string;
  electron: string;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export type ProgressKind = 'info' | 'success' | 'warn' | 'error';

export interface FetchProgress {
  step: string;
  percent: number;
  matched?: number;
  saved?: number;
  skipped?: number;
  message: string;
  kind: ProgressKind;
  done: boolean;
}

export interface OperationProgress {
  operation: 'ocr';
  phase: string;
  percent: number;
  total?: number;
  processed?: number;
  parsed?: number;
  skipped?: number;
  failed?: number;
  code?: string;
  message: string;
  kind: ProgressKind;
  done: boolean;
}

export interface FileProgress {
  operation: 'files';
  phase: string;
  percent: number;
  processed?: number;
  skipped?: number;
  failed?: number;
  message: string;
  kind: ProgressKind;
  done: boolean;
}

export type OpKind = 'fetch' | 'pipeline' | 'ocr' | 'organize';

export interface RunningOp {
  kind: OpKind;
  jobId: string;
  startedAt: number;
}

export interface OpState {
  running: RunningOp | null;
}

/** 订阅中心支持的事件通道。 */
export interface BridgeEvents {
  fetchProgress: FetchProgress;
  operationProgress: OperationProgress;
  fileProgress: FileProgress;
  opState: OpState;
}

export type BridgeEventName = keyof BridgeEvents;

// ---------------------------------------------------------------------------
// 桥接接口
// ---------------------------------------------------------------------------

/** preload 暴露的原始对象。事件订阅每个通道只保留一个监听器。 */
export interface MfhBridge {
  getSummary(payload?: SummaryQuery): Promise<AppSummary>;
  getConfig(): Promise<ConfigPayload>;
  saveConfig(payload: ConfigDraft): Promise<SaveConfigResult>;
  startFetch(payload: StartFetchPayload): Promise<TerminalResult>;
  runPipeline(payload: RunPipelinePayload): Promise<TerminalResult>;
  runOcr(payload: RunOcrPayload): Promise<TerminalResult>;
  stopOcr(): Promise<BaseResult>;
  organize(payload: OrganizePayload): Promise<OrganizeResult>;
  openPath(payload: OpenPathPayload): Promise<OpenResult>;
  copyText(payload: { text: string }): Promise<BaseResult>;
  getOpState(): Promise<OpState>;
  getAppInfo(): Promise<AppInfo>;
  testMailConnection(payload: ConfigDraft): Promise<TestConnectionResult>;
  listMailboxes(payload: ConfigDraft): Promise<ListMailboxesResult>;
  pendingIgnore(payload: { hash: string }): Promise<PendingIgnoreResult>;
  pendingRefreshLink(payload: { hash: string }): Promise<OpenMailResult>;
  pendingManualArchive(payload: { hash: string }): Promise<PendingManualArchiveResult>;
  developerReset(): Promise<DeveloperResetResult>;
  archiveJournalStatus(): Promise<ArchiveJournalStatus>;
  archiveJournalQuarantine(payload: { confirm: true }): Promise<BaseResult>;
  onFetchProgress(cb: (data: FetchProgress) => void): void;
  onOperationProgress(cb: (data: OperationProgress) => void): void;
  onFileProgress(cb: (data: FileProgress) => void): void;
  onOpState(cb: (data: OpState) => void): void;

  // 旧版本可能没有的通道；调用前用 bridge.supports() 判断可用性。
  mailDetail?(payload: { hash: string }): Promise<MailDetailResult>;
  openMail?(payload: OpenMailPayload): Promise<OpenMailResult>;
  invoiceDetail?(payload: { filename: string }): Promise<InvoiceDetailResult>;
  dedupe?(payload: DedupePayload): Promise<DedupeResult>;
  openExternal?(payload: { url: string }): Promise<BaseResult>;
  pickDirectory?(payload: PickDirectoryPayload): Promise<PickDirectoryResult>;
  exportCsv?(payload: ExportCsvPayload): Promise<ExportCsvResult>;
}

declare global {
  interface Window {
    mfhBridge?: MfhBridge;
  }
}
