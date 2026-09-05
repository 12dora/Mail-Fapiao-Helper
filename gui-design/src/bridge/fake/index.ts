/**
 * 浏览器预览用的内存桥接。
 *
 * 打开条件：`window.mfhBridge` 不存在，或 URL 带 `?fake=…`（截图脚本用 `fake=1`）。
 * 每一组方法单独成函数，纯粹是为了让每个函数都读得完——它们共享的只有变体和事件中心。
 */
import type {
  AppInfo,
  ArchiveJournalStatus,
  BaseResult,
  DedupeGroup,
  DedupePayload,
  DedupeResult,
  DeveloperResetResult,
  ExportCsvResult,
  FetchProgress,
  FileProgress,
  InvoiceDetailResult,
  ListMailboxesResult,
  MailDetailResult,
  MfhBridge,
  OpenMailResult,
  OpenResult,
  OperationProgress,
  OpState,
  OrganizeResult,
  PendingIgnoreResult,
  PendingManualArchiveResult,
  PickDirectoryResult,
  RunningOp,
  SaveConfigResult,
  StartFetchPayload,
  TerminalResult,
  TestConnectionResult,
} from '../types.js';
import {
  attachmentsFor,
  buildSummary,
  configFor,
  CONFLICT_PAIR,
  dataset,
  DUPLICATE_PAIRS,
  UNREADABLE_INDEX,
  type FakeVariant,
} from './data.js';
import { fetchFrames, fileFrames, ocrFrames } from './progress.js';

type Cb<T> = (data: T) => void;

const PREVIEW: BaseResult = { ok: true, code: 'preview_only', message: '预览模式不会调用本机程序。' };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 事件中心
// ---------------------------------------------------------------------------

interface Events {
  running(): RunningOp | null;
  stop(): boolean;
  simulate<T>(kind: RunningOp['kind'], frames: T[], send: (frame: T) => void): Promise<void>;
  fetch: Cb<FetchProgress> | null;
  op: Cb<OperationProgress> | null;
  file: Cb<FileProgress> | null;
  subscriptions: Pick<MfhBridge, 'onFetchProgress' | 'onOperationProgress' | 'onFileProgress' | 'onOpState'>;
}

function createEvents(): Events {
  let running: RunningOp | null = null;
  let stopRequested = false;
  let opStateCb: Cb<OpState> | null = null;
  const self: Events = {
    running: () => running,
    stop: () => {
      if (!running) return false;
      stopRequested = true;
      return true;
    },
    fetch: null,
    op: null,
    file: null,
    async simulate(kind, frames, send) {
      running = { kind, jobId: `job-${Date.now()}`, startedAt: Date.now() };
      opStateCb?.({ running });
      stopRequested = false;
      for (const frame of frames) {
        if (stopRequested) break;
        send(frame);
        await sleep(260);
      }
      running = null;
      opStateCb?.({ running: null });
    },
    subscriptions: {
      onFetchProgress(cb) {
        self.fetch = cb;
      },
      onOperationProgress(cb) {
        self.op = cb;
      },
      onFileProgress(cb) {
        self.file = cb;
      },
      onOpState(cb) {
        opStateCb = cb;
        cb({ running });
      },
    },
  };
  return self;
}

// ---------------------------------------------------------------------------
// 长任务
// ---------------------------------------------------------------------------

type RunMethods = Pick<MfhBridge, 'startFetch' | 'runPipeline' | 'runOcr' | 'stopOcr' | 'organize'>;

function runMethods(variant: FakeVariant, events: Events): RunMethods {
  const summary = () => buildSummary(variant);
  return {
    async startFetch(payload: StartFetchPayload): Promise<TerminalResult> {
      await events.simulate('fetch', fetchFrames(payload.dryRun), (f) => events.fetch?.(f));
      const rows = dataset(variant).inbox.slice(0, 18);
      return {
        ok: true,
        status: 'success',
        started: true,
        jobId: 'fake-fetch',
        message: payload.dryRun ? '试运行完成，未下载邮件。' : `已完成，新增 ${rows.length} 封邮件。`,
        summary: summary(),
        normalizedFilter: { matchSubject: payload.matchSubject, matchBody: payload.matchBody },
        batch: {
          total: rows.length,
          rows: rows.map((row) => ({
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
      await events.simulate('pipeline', fileFrames(), (f) => events.file?.(f));
      return {
        ok: true,
        status: 'success',
        started: true,
        message: '已完成，新增 12 份发票。',
        summary: summary(),
        batch: { total: 12, rows: [] },
      };
    },

    async runOcr(): Promise<TerminalResult> {
      await events.simulate('ocr', ocrFrames(), (f) => events.op?.(f));
      return {
        ok: true,
        status: 'partial',
        started: true,
        message: '识别 12 份，3 份信息不完整。',
        summary: summary(),
      };
    },

    async stopOcr(): Promise<BaseResult> {
      if (!events.stop()) return { ok: false, code: 'ocr_not_running', message: '当前没有正在运行的识别任务。' };
      return { ok: true, code: 'ocr_stopping', message: '正在停止识别。' };
    },

    async organize(): Promise<OrganizeResult> {
      await sleep(400);
      const total = dataset(variant).library.length;
      return {
        ok: true,
        status: 'success',
        message: `已整理 ${total} 份文件。`,
        counts: { scanned: total, copied: total, skipped: 0, failed: 0 },
        summary: summary(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 详情与去重
// ---------------------------------------------------------------------------

type DetailMethods = Required<Pick<MfhBridge, 'mailDetail' | 'openMail' | 'invoiceDetail' | 'dedupe'>>;

function dedupeGroups(variant: FakeVariant): DedupeGroup[] {
  const rows = dataset(variant).library;
  return DUPLICATE_PAIRS.flatMap(([keep, dup]) => {
    const a = rows[keep];
    const b = rows[dup];
    if (!a || !b || !a.invoiceNo) return [];
    const member = (row: typeof a, reason?: string) => ({
      filename: row.filename,
      date: row.date,
      seller: row.seller,
      amount: row.amount,
      format: row.filename.split('.').pop() ?? 'pdf',
      ...(reason ? { reason } : {}),
    });
    const conflict = keep === CONFLICT_PAIR[0];
    return [
      {
        invoiceNo: a.invoiceNo,
        kept: member(a),
        removed: [member(b, conflict ? 'amount_mismatch' : 'same_invoice_no')],
        conflict,
        conflictReason: conflict ? '两份的金额对不上，需要人工核对。' : '',
      },
    ];
  });
}

function detailMethods(variant: FakeVariant): DetailMethods {
  return {
    async mailDetail(payload): Promise<MailDetailResult> {
      await sleep(120);
      const rows = dataset(variant).inbox;
      const index = rows.findIndex((row) => row.mailHash === payload.hash);
      const mail = rows[index];
      if (!mail) return { ok: false, code: 'mail_not_found', message: '找不到这封邮件。' };
      if (index === UNREADABLE_INDEX) {
        return { ok: false, code: 'eml_unreadable', message: '无法读取原始邮件。', detail: '文件可能已损坏。' };
      }
      const documents = dataset(variant).library.filter((row) => row.mailHash === mail.mailHash);
      return {
        ok: true,
        mail: {
          ...mail,
          emlExists: mail.mailOpenable,
          emlLocation: mail.mailOpenable ? (mail.status === 'pending' ? 'pending' : 'samples') : null,
          attachments: attachmentsFor(index, mail.hasAttachment),
          links: Array.from({ length: Math.min(mail.bodyLinkCount, 3) }, (_, i) => ({
            url: `https://invoice.example.com/download/${mail.mailHash}/${i + 1}`,
            label: `下载发票 ${i + 1}`,
          })),
          documents,
          pending:
            mail.status === 'pending'
              ? {
                  reason: 'link_expired',
                  category: '链接失效',
                  userMessage: '发票链接已过期，需要重新获取。',
                  nextStep: '打开原始邮件，按邮件里的入口重新下载。',
                }
              : null,
          history: [{ time: mail.date, action: 'fetch', status: 'success', message: '已保存原始邮件' }],
        },
      };
    },

    async openMail(): Promise<OpenMailResult> {
      await sleep(120);
      return { ...PREVIEW, opened: 'mail' };
    },

    async invoiceDetail(payload): Promise<InvoiceDetailResult> {
      await sleep(120);
      const rows = dataset(variant).library;
      const index = rows.findIndex((r) => r.filename === payload.filename);
      const row = rows[index];
      if (!row) return { ok: false, code: 'invoice_not_found', message: '找不到这份发票。' };
      const format = row.filename.split('.').pop() ?? 'pdf';
      return {
        ok: true,
        invoice: {
          row,
          ocr:
            row.status === '完整'
              ? {
                  documentType: row.documentType,
                  invoiceType: row.invoiceType,
                  seller: row.seller,
                  amount: row.amount,
                  dateValue: row.date,
                  invoiceNo: row.invoiceNo,
                  transport: '',
                  // 文本层能直接取字的走 text_layer，图片扫描件才落到 ocr。
                  extractedBy: format === 'pdf' && index % 3 !== 0 ? 'text_layer' : 'ocr',
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
            source: row.source,
            mailHash: row.mailHash,
            contentHash: row.contentHash,
          },
          file: { handle: row.fileHandle, exists: index % 17 !== 5, size: 187654, format },
          duplicates: row.duplicateGroup
            ? rows.filter((r) => r.duplicateGroup === row.duplicateGroup && r.filename !== row.filename)
            : [],
        },
      };
    },

    async dedupe(payload: DedupePayload): Promise<DedupeResult> {
      await sleep(600);
      const groups = dedupeGroups(variant);
      // 计数一律从要展示的分组里数出来，界面上的数字和列表不会对不上。
      const redundant = groups
        .filter((group) => !group.conflict)
        .reduce((n, group) => n + group.removed.length, 0);
      const conflicts = groups.filter((group) => group.conflict).length;
      const moved = payload.apply ? redundant : 0;
      return {
        ok: true,
        status: 'success',
        message: payload.apply ? `已隔离 ${moved} 份重复发票。` : `发现 ${groups.length} 组重复发票。`,
        report: {
          mode: payload.by,
          applied: payload.apply,
          quarantineDir: payload.apply ? 'invoices/.dedupe-quarantine/20260905-0900/by-invoice-no' : null,
          pairs: groups.length,
          redundant,
          quarantined: moved,
          ledgerRowsRemoved: moved,
          ocrRowsRemoved: moved,
          conflicts,
          groups,
          skipped: [{ filename: '2026-08-30-1042.ofd', reason: '缺少发票号，不参与同号比对。' }],
        },
        summary: buildSummary(variant),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 其余通道
// ---------------------------------------------------------------------------

type PlainMethods = Omit<MfhBridge, keyof RunMethods | keyof DetailMethods | keyof Events['subscriptions']>;

function plainMethods(variant: FakeVariant): PlainMethods {
  return {
    async getSummary() {
      await sleep(60);
      return buildSummary(variant);
    },
    async getConfig() {
      await sleep(40);
      return configFor(variant);
    },
    async saveConfig(): Promise<SaveConfigResult> {
      await sleep(120);
      if (variant === 'broken') {
        return {
          ok: false,
          message: '设置未保存。',
          fieldErrors: [{ path: 'imap.port', message: '端口需要在 1 到 65535 之间。' }],
        };
      }
      return { ok: true, configPath: configFor(variant).configPath, message: '已保存到本机。' };
    },

    async openPath(): Promise<OpenResult> {
      await sleep(80);
      return { ...PREVIEW };
    },
    async copyText(payload): Promise<BaseResult> {
      try {
        await navigator.clipboard.writeText(payload.text);
      } catch {
        // 预览模式下剪贴板可能不可用，忽略即可。
      }
      return { ok: true };
    },
    async openExternal(): Promise<BaseResult> {
      await sleep(60);
      return { ...PREVIEW };
    },
    async pickDirectory(): Promise<PickDirectoryResult> {
      await sleep(120);
      return { ok: false, canceled: true, code: 'preview_only', message: '预览模式不会打开选择框。' };
    },
    async exportCsv(): Promise<ExportCsvResult> {
      await sleep(160);
      return { ok: false, canceled: true, code: 'preview_only', message: '预览模式不会打开保存框。' };
    },

    async getOpState(): Promise<OpState> {
      return { running: null };
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
      return {
        ok: true,
        code: 'pending_ignored',
        message: '已移出待确认。',
        removed: 1,
        summary: buildSummary(variant),
      };
    },
    async pendingRefreshLink(): Promise<OpenMailResult> {
      await sleep(120);
      return { ...PREVIEW, opened: 'mail' };
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
  };
}

export function createFakeBridge(variant: FakeVariant = 'demo'): MfhBridge {
  const events = createEvents();
  const plain = plainMethods(variant);
  return {
    ...plain,
    ...runMethods(variant, events),
    ...detailMethods(variant),
    ...events.subscriptions,
    // getOpState 要看实时状态，不能用 plainMethods 里那份常量。
    getOpState: async () => ({ running: events.running() }),
  };
}
