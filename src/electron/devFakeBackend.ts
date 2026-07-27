import fs from 'node:fs';
import path from 'node:path';
import type * as ElectronAPI from 'electron';
import { csvCell } from '../util/csv.js';
import { msgIdHash } from '../util/hash.js';

/**
 * 仅供本地开发与 e2e fixture 使用的假后端（CODE-04）。
 *
 * 这些函数会按真实配置路径无条件覆盖 INDEX、OCR 队列、结果 CSV、pending 和示例
 * PDF，属于数据破坏性代码，绝不能出现在生产主进程的可达路径上。main.ts 只有在
 * `!app.isPackaged && MFH_E2E_FAKE_CLI === '1'` 时才会动态 import 本模块；打包后
 * 无论环境变量如何都走真实 CLI。
 */

export interface FakeBackendContext {
  dataDir: string;
  /** 读取当前（可能损坏时回退到 example）的配置对象。 */
  readConfig(): Record<string, unknown>;
}

export interface FakeCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function fakeConfigPaths(ctx: FakeBackendContext): {
  samples: string;
  invoices: string;
  pending: string;
  resultsCsv: string;
  organizedDir: string;
} {
  const cfg = ctx.readConfig();
  const paths = asObject(cfg.paths);
  const ocr = asObject(cfg.ocr);
  const rename = asObject(cfg.rename);
  const resolve = (value: unknown, fallback: string): string =>
    path.resolve(ctx.dataDir, typeof value === 'string' && value.length > 0 ? value : fallback);
  return {
    samples: resolve(paths.samples, './samples/raw'),
    invoices: resolve(paths.invoices, './invoices'),
    pending: resolve(paths.pending, './pending'),
    resultsCsv: resolve(ocr.resultsCsv, './invoices/ocr/ocr-results.csv'),
    organizedDir: resolve(rename.organizedDir, './invoices/organized'),
  };
}

function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function csvText(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

/**
 * 固定的两封样例邮件。真实 CLI 的逐封日志用 `msgIdHash`，这里必须用同一个算法，
 * 否则 fixture 走不到 main 侧的批次还原逻辑（APP-20）。
 */
const FAKE_MAILS = [
  {
    messageId: '<mfh-e2e-invoice@example.com>',
    date: '2026-05-21T09:30:00.000Z',
    from: '国家电网 <noreply@example.com>',
    subject: '国家电网电子发票通知',
    mailbox: 'INBOX',
    hasAttachment: '1',
    bodyLinkCount: '2',
  },
  {
    messageId: '<mfh-e2e-link@example.com>',
    date: '2026-05-20T12:00:00.000Z',
    from: '服务商 <vendor@example.com>',
    subject: '发票下载链接已过期',
    mailbox: 'INBOX',
    hasAttachment: '0',
    bodyLinkCount: '1',
  },
] as const;

function fakeMailHash(mail: (typeof FAKE_MAILS)[number]): string {
  return msgIdHash(mail.messageId, mail.from, mail.date, mail.subject);
}

function monthDir(iso: string): string {
  return iso.slice(0, 7);
}

function fakeFetch(ctx: FakeBackendContext, args: string[]): FakeCliResult {
  const paths = fakeConfigPaths(ctx);
  const dryRun = args.includes('--dry-run');

  if (dryRun) {
    // 与真实 CLI 一致：预览不写缓存、不写 INDEX、不产生 `saved` 行，
    // 因此 main 侧也不会回显 batch。
    return {
      code: 0,
      stdout: [
        ...FAKE_MAILS.map((mail) => {
          const emlPath = path.join(paths.samples, monthDir(mail.date), `${fakeMailHash(mail)}.eml`);
          return `[dry-run] would save ${emlPath} (subject="${mail.subject}")`;
        }),
        `done: seen=${FAKE_MAILS.length} saved=0 repaired=0 skippedKnown=0 dryRun=true`,
        '',
      ].join('\n'),
      stderr: '',
    };
  }

  writeFile(path.join(paths.samples, 'INDEX.csv'), csvText([
    ['messageId', 'date', 'from', 'subject', 'mailbox', 'hasAttachment', 'bodyLinkCount'],
    ...FAKE_MAILS.map((mail) => [
      mail.messageId, mail.date, mail.from, mail.subject, mail.mailbox, mail.hasAttachment, mail.bodyLinkCount,
    ]),
  ]));
  writeFile(
    path.join(paths.samples, monthDir(FAKE_MAILS[0].date), `${fakeMailHash(FAKE_MAILS[0])}.eml`),
    'Subject: 国家电网电子发票通知\n\nfake invoice mail\n',
  );
  return {
    code: 0,
    stdout: [
      ...FAKE_MAILS.map((mail) => `saved ${fakeMailHash(mail)} subject="${mail.subject}"`),
      `done: seen=${FAKE_MAILS.length} saved=${FAKE_MAILS.length} repaired=0 skippedKnown=0 dryRun=false`,
      '',
    ].join('\n'),
    stderr: '',
  };
}

function fakePipeline(ctx: FakeBackendContext, args: string[]): FakeCliResult {
  const onlyMailIndex = args.indexOf('--only-mail');
  const onlyMail = onlyMailIndex >= 0 ? args[onlyMailIndex + 1] : undefined;
  const paths = fakeConfigPaths(ctx);
  writeFile(path.join(paths.invoices, 'ocr', 'ocr-pending.csv'), csvText([
    ['hash', 'date', 'from', 'subject', 'filename', 'format', 'documentType', 'status', 'reason'],
    ['mfh-e2e-invoice', '2026-05-21', '国家电网 <noreply@example.com>', '国家电网电子发票通知', '0001.pdf', 'pdf', 'invoice', 'pending', ''],
    ['mfh-e2e-trip', '2026-05-20', '差旅平台 <travel@example.com>', '行程单通知', '0002.pdf', 'pdf', 'itinerary', 'pending', ''],
    ['mfh-e2e-supporting', '2026-05-20', '高速通行 <etc@example.com>', '通行费汇总单', '通行费电子票据汇总单.pdf', 'pdf', 'supporting', 'ignored', 'supporting_document'],
  ]));
  writeFile(path.join(paths.invoices, '0001.pdf'), '%PDF-1.4\n% fake\n');
  writeFile(path.join(paths.invoices, '0002.pdf'), '%PDF-1.4\n% fake\n');
  // `--only-mail <hash>` 时真实 CLI 只处理这一封，fixture 也照做，
  // 这样「本次运行」批次在两边是同一个语义。
  const handled = onlyMail
    ? FAKE_MAILS.filter((mail) => fakeMailHash(mail) === onlyMail)
    : [...FAKE_MAILS];
  const documents = [2, 1];
  return {
    code: 0,
    stdout: [
      ...handled.map((mail, i) => `Processed ${fakeMailHash(mail)}: ${documents[i] ?? 1} documents`),
      `Run complete: processed=${handled.length}, partial=0, skipped=0, failed=0`,
      '',
    ].join('\n'),
    stderr: '',
  };
}

function fakeOcr(ctx: FakeBackendContext): FakeCliResult {
  const paths = fakeConfigPaths(ctx);
  writeFile(path.join(paths.invoices, 'ocr', 'ocr-pending.csv'), csvText([
    ['hash', 'date', 'from', 'subject', 'filename', 'source', 'format', 'documentType', 'status', 'reason'],
    ['mfh-e2e-invoice', '2026-05-21', '国家电网 <noreply@example.com>', '国家电网电子发票通知', '0001.pdf', '0001.pdf', 'pdf', 'invoice', 'recognized', ''],
    ['mfh-e2e-trip', '2026-05-20', '差旅平台 <travel@example.com>', '行程单通知', '0002.pdf', '0002.pdf', 'pdf', 'itinerary', 'recognized', ''],
    ['mfh-e2e-supporting', '2026-05-20', '高速通行 <etc@example.com>', '通行费汇总单', '通行费电子票据汇总单.pdf', '通行费电子票据汇总单.pdf', 'pdf', 'supporting', 'ignored', 'supporting_document'],
  ]));
  writeFile(paths.resultsCsv, csvText([
    ['filename', 'dateValue', 'date', 'seller', 'invoiceNo', 'amount', 'transport', 'status', 'documentType', 'invoiceType', 'error'],
    ['0001.pdf', '2026-05-21', '2026-05-21', '国家电网有限公司', '1234567890', '318.42', 'http', 'ok', 'invoice', '电子发票', ''],
    ['0002.pdf', '2026-05-20', '2026-05-20', '差旅平台', 'TRIP-20260520', '88.00', 'http', 'ok', 'itinerary', '行程单', ''],
  ]));
  writeFile(path.join(paths.pending, 'pending.csv'), csvText([
    ['messageId', 'date', 'from', 'subject', 'reason'],
    ['<mfh-e2e-link@example.com>', '2026-05-20T12:00:00.000Z', '服务商 <vendor@example.com>', '发票下载链接已过期', 'http_403'],
  ]));
  fs.mkdirSync(paths.organizedDir, { recursive: true });
  return {
    code: 0,
    stdout: [
      'OCR parsed 0001.pdf',
      'OCR parsed 0002.pdf',
      'OCR complete: scanned=3, parsed=2, skipped=1, failed=0, updated=2',
      '',
    ].join('\n'),
    stderr: '',
  };
}

/**
 * @param args 真实传给 CLI 的 argv。fixture 必须按同一批参数分支（例如 `--dry-run`
 *   不写盘也不产生 `saved` 行），否则 fixture 覆盖的就不是真实契约。
 */
export function runFakeCli(command: string, args: string[], ctx: FakeBackendContext): FakeCliResult {
  if (command === 'fetch') return fakeFetch(ctx, args);
  if (command === 'run') return fakePipeline(ctx, args);
  if (command === 'ocr') return fakeOcr(ctx);
  if (command === 'organize') {
    const paths = fakeConfigPaths(ctx);
    fs.mkdirSync(paths.organizedDir, { recursive: true });
    return { code: 0, stdout: `organized into ${paths.organizedDir}\n`, stderr: '' };
  }
  return { code: 1, stdout: '', stderr: `unsupported fake command: ${command}` };
}

export function fakeConnectionResult(): { ok: true; message: string } {
  return { ok: true, message: '邮箱连接正常，可以获取邮件。' };
}

export function fakeMailboxes(): string[] {
  return ['INBOX', 'Sent Messages', '邮件归档'];
}

/**
 * 把测试探针注入 renderer。仅在 fake backend 已加载（即非打包 + 显式环境变量）
 * 时会被调用，生产构建不会执行任何 executeJavaScript 注入。
 */
export function recordTestGlobal(
  win: ElectronAPI.BrowserWindow | undefined,
  key: string,
  value: unknown,
): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents
    .executeJavaScript(`window[${JSON.stringify(key)}] = ${JSON.stringify(value)}`)
    .catch(() => {});
}
