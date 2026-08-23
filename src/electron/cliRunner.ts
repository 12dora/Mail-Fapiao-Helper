import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { LineAssembler, LineRingBuffer } from './lineStream.js';
import type { OperationCoordinator } from './opCoordinator.js';
import { sanitizeText, type UiError } from './sanitize.js';
import type * as DevFakeBackend from './devFakeBackend.js';
import {
  MANUAL_MAIL_RE,
  PROCESSED_MAIL_RE,
  SAVED_MAIL_RE,
  logicalTerminalLine,
  parseFetchLine,
  parseFileLine,
  parseOcrCompleteCounts,
  parseOcrLine,
  parseRunCompleteCounts,
  sendFilePhase,
  sendOcrPhase,
  terminalGuard,
  terminalLineFailureMarkers,
  type FetchProgressState,
  type FileProgressState,
  type OcrProgressState,
  type ProgressSink,
  type RunTerminalCounts,
} from './cliProtocol.js';

// ---------------------------------------------------------------------------
// CLI 子进程
// ---------------------------------------------------------------------------

export interface RunCliOptions {
  progress?: boolean;
  operation?: 'ocr' | 'files';
  initialTotal?: number;
  jobId?: string;
}

/**
 * 本次运行真正触达的邮件身份（APP-20）。逐行流式收集，而不是事后从 stdout tail
 * 里回捞——诊断输出是有界 ring buffer，长任务会把早期的 `saved/Processed` 行挤掉。
 */
export interface RunCliMails {
  /** fetch：本次新写入本机缓存的邮件。 */
  saved: string[];
  /** run：本次真正归档成功的邮件。 */
  processed: string[];
  /** run：本次被降级到待确认队列的邮件。 */
  manual: string[];
}

export interface RunCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 子进程是否成功启动（spawn 失败时为 false，供 APP-17 判断是否回滚）。 */
  started: boolean;
  spawnError?: UiError;
  mails: RunCliMails;
  /** pipeline `Run complete:` 结构化计数；无终态行时为 undefined。 */
  runCounts?: RunTerminalCounts;
  /** OCR `OCR complete:` 结构化计数。 */
  ocrCounts?: ReturnType<typeof parseOcrCompleteCounts>;
  /**
   * 终态行上捕获的 mail_not_found（独立于 ring buffer，避免后续诊断行挤掉标记）。
   */
  terminalMailNotFound?: boolean;
}


export interface CliRunnerDependencies {
  rootDir: string;
  dataDir: string;
  coordinator: Pick<OperationCoordinator, 'leaseEnv'>;
  getDevBackend(): typeof DevFakeBackend | undefined;
  readConfigForPaths(): Record<string, unknown>;
  activeChildren: Set<ChildProcess>;
  ocrProcesses: Map<string, ChildProcess>;
  ocrStopRequested: Set<string>;
  sendProgress: ProgressSink;
  sendOperationProgress: ProgressSink;
  sendFileProgress: ProgressSink;
}

interface RunState {
  emitFetch: ProgressSink;
  emitOcr: ProgressSink;
  emitFiles: ProgressSink;
  current: FetchProgressState;
  ocrCurrent: OcrProgressState;
  fileCurrent: FileProgressState;
  capturedRunCounts: RunTerminalCounts | undefined;
  capturedOcrCounts: ReturnType<typeof parseOcrCompleteCounts>;
  capturedTerminalMailNotFound: boolean;
  mails(): RunCliMails;
  captureTerminalLine(line: string): void;
  handleLine(line: string): void;
}

interface OutputStreams {
  stdoutTail: LineRingBuffer;
  stderrTail: LineRingBuffer;
  stdoutLines: LineAssembler;
  stderrLines: LineAssembler;
}

interface SettlementState {
  settled: boolean;
}

function createRunState(
  opts: RunCliOptions,
  sendProgress: ProgressSink,
  sendOperationProgress: ProgressSink,
  sendFileProgress: ProgressSink,
): RunState {
  const emitFetch = terminalGuard(sendProgress);
  const emitOcr = terminalGuard(sendOperationProgress);
  const emitFiles = terminalGuard(sendFileProgress);
  const current: FetchProgressState = { seen: 0, saved: 0, skipped: 0, repaired: 0 };
  const ocrCurrent: OcrProgressState = { total: opts.initialTotal ?? 0, parsed: 0, failed: 0, skipped: 0, processed: 0, initialized: false };
  const fileCurrent: FileProgressState = {
    total: 0, processed: 0, archived: 0, pending: 0, skipped: 0, failed: 0, partial: 0,
  };
  const savedMails = new Set<string>();
  const processedMails = new Set<string>();
  const manualMails = new Set<string>();
  const state: RunState = {
    emitFetch,
    emitOcr,
    emitFiles,
    current,
    ocrCurrent,
    fileCurrent,
    // NEW DEFECT 2：终态计数独立于有界 ring——首次见到即保留，后续诊断行不得挤掉权威结果。
    capturedRunCounts: undefined,
    capturedOcrCounts: undefined,
    capturedTerminalMailNotFound: false,
    mails: () => ({
      saved: Array.from(savedMails),
      processed: Array.from(processedMails),
      manual: Array.from(manualMails),
    }),
    captureTerminalLine: (line: string): void => {
      const text = logicalTerminalLine(line);
      if (!text) return;
      if (text.startsWith('Run complete:')) {
        const counts = parseRunCompleteCounts(text);
        if (counts) state.capturedRunCounts = counts;
        const markers = terminalLineFailureMarkers(text);
        if (markers.mailNotFound) state.capturedTerminalMailNotFound = true;
      }
      if (text.startsWith('OCR complete:')) {
        const counts = parseOcrCompleteCounts(text);
        if (counts) state.capturedOcrCounts = counts;
      }
      // 非终态行上的 mail_not_found 日志也捕获（stderr 常见），同样不依赖 ring
      if (/\bmail_not_found\b/i.test(text)) state.capturedTerminalMailNotFound = true;
    },
    handleLine: (line: string): void => {
      if (!line.trim()) return;
      state.captureTerminalLine(line);
      const saved = SAVED_MAIL_RE.exec(line);
      if (saved?.[1]) savedMails.add(saved[1]);
      const processed = PROCESSED_MAIL_RE.exec(line);
      if (processed?.[1]) processedMails.add(processed[1]);
      const manual = MANUAL_MAIL_RE.exec(line);
      if (manual?.[1]) manualMails.add(manual[1]);
      if (opts.progress) parseFetchLine(line, current, emitFetch);
      if (opts.operation === 'ocr') parseOcrLine(line, ocrCurrent, emitOcr);
      if (opts.operation === 'files') parseFileLine(line, fileCurrent, emitFiles);
    },
  };
  return state;
}

function runFakeCli(
  devBackend: typeof DevFakeBackend,
  command: string,
  args: string[],
  opts: RunCliOptions,
  dataDir: string,
  readConfigForPaths: () => Record<string, unknown>,
  state: RunState,
  resolve: (result: RunCliResult) => void,
): void {
  const fake = devBackend.runFakeCli(command, args, { dataDir, readConfig: readConfigForPaths });
  if (opts.progress) {
    state.emitFetch({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', code: 'fetch_phase', message: '正在连接邮箱并搜索邮件。' });
  } else if (opts.operation === 'ocr') {
    state.ocrCurrent.initialized = true;
    sendOcrPhase('正在调用本机识别引擎。', state.emitOcr, state.ocrCurrent);
  } else if (opts.operation === 'files') {
    sendFilePhase('正在从本地邮件中获取发票文件。', state.emitFiles, state.fileCurrent);
  }
  const combined = `${fake.stdout}\n${fake.stderr}`;
  for (const line of combined.split(/\r?\n/)) state.handleLine(line);
  resolve({
    ...fake,
    started: true,
    mails: state.mails(),
    runCounts: state.capturedRunCounts ?? parseRunCompleteCounts(combined),
    ocrCounts: state.capturedOcrCounts ?? parseOcrCompleteCounts(combined),
    ...(state.capturedTerminalMailNotFound ? { terminalMailNotFound: true } : {}),
  });
}

function spawnCli(
  command: string,
  args: string[],
  rootDir: string,
  dataDir: string,
  coordinator: Pick<OperationCoordinator, 'leaseEnv'>,
  activeChildren: Set<ChildProcess>,
): ChildProcessWithoutNullStreams {
  const env = {
    ...process.env,
    MFH_APP_ROOT: rootDir,
    MFH_RESOURCE_ROOT: process.resourcesPath,
    // 当前数据目录租约的凭证：子进程凭 token 与磁盘锁文件比对来判定「继承租约」，
    // 而不是凭 ppid（APP-05）。
    ...coordinator.leaseEnv(),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  // ELEC-04：POSIX 上以独立进程组启动，终止时才能对负 PGID 杀掉 efapiao serve 孙进程。
  const child = spawn(process.execPath, [path.join(rootDir, 'dist', 'index.js'), command, ...args], {
    cwd: dataDir,
    env,
    detached: process.platform !== 'win32',
  });
  activeChildren.add(child);
  return child;
}

function attachOutputStreams(
  child: ChildProcessWithoutNullStreams,
  opts: RunCliOptions,
  state: RunState,
  streams: OutputStreams,
): void {
  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of streams.stdoutLines.push(chunk)) {
      streams.stdoutTail.push(line);
      state.handleLine(line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of streams.stderrLines.push(chunk)) {
      streams.stderrTail.push(line);
      // OCR/files：完整 handleLine（内含 capture）。其它命令也要捕获终态/mail_not_found。
      if (opts.operation === 'ocr' || opts.operation === 'files') state.handleLine(line);
      else state.captureTerminalLine(line);
    }
  });
}

function emitProcessFailure(
  err: Error,
  child: ChildProcess,
  opts: RunCliOptions,
  state: RunState,
  settlement: SettlementState,
  activeChildren: Set<ChildProcess>,
  ocrProcesses: Map<string, ChildProcess>,
  resolve: (result: RunCliResult) => void,
): void {
  activeChildren.delete(child);
  if (opts.jobId) ocrProcesses.delete(opts.jobId);
  if (settlement.settled) return;
  settlement.settled = true;
  const spawnError: UiError = {
    code: 'cli_spawn_failed',
    message: '无法启动后台任务，请重新打开应用后重试。',
    detail: sanitizeText(err.message),
  };
  if (opts.progress) {
    state.emitFetch({ percent: 100, step: '失败', ...spawnError, kind: 'err', done: true });
  } else if (opts.operation === 'ocr') {
    state.emitOcr({ operation: 'ocr', phase: '识别失败', percent: 100, ...spawnError, kind: 'err', done: true });
  } else if (opts.operation === 'files') {
    state.emitFiles({ operation: 'files', phase: '获取失败', percent: 100, ...spawnError, kind: 'err', done: true });
  }
  resolve({
    code: null,
    stdout: '',
    stderr: spawnError.detail ?? '',
    started: false,
    spawnError,
    mails: state.mails(),
  });
}

function finalizeCliResult(
  code: number | null,
  child: ChildProcess,
  opts: RunCliOptions,
  state: RunState,
  streams: OutputStreams,
  settlement: SettlementState,
  activeChildren: Set<ChildProcess>,
  ocrProcesses: Map<string, ChildProcess>,
  ocrStopRequested: Set<string>,
  resolve: (result: RunCliResult) => void,
): void {
  activeChildren.delete(child);
  if (opts.jobId) ocrProcesses.delete(opts.jobId);
  if (settlement.settled) return;
  settlement.settled = true;
  // 关闭时把 carry 里的半行交给解析器，终态行不会因 chunk 边界丢失。
  for (const line of streams.stdoutLines.flush()) {
    streams.stdoutTail.push(line);
    state.handleLine(line);
  }
  for (const line of streams.stderrLines.flush()) {
    streams.stderrTail.push(line);
    if (opts.operation === 'ocr' || opts.operation === 'files') state.handleLine(line);
    else state.captureTerminalLine(line);
  }

  const out = streams.stdoutTail.toString();
  const err = streams.stderrTail.toString();
  const combined = `${out}\n${err}`;
  // 优先使用流式捕获的权威终态；ring 里可能已无该行
  const runCounts = state.capturedRunCounts ?? parseRunCompleteCounts(combined);
  const ocrCounts = state.capturedOcrCounts ?? parseOcrCompleteCounts(combined);
  const detail = sanitizeText(err.trim() || out.trim(), { maxLength: 400 });
  const stopped = opts.jobId ? ocrStopRequested.has(opts.jobId) : false;

  if (opts.operation === 'ocr' && stopped) {
    state.emitOcr({
      operation: 'ocr',
      phase: '已停止',
      percent: 100,
      total: state.ocrCurrent.total,
      processed: state.ocrCurrent.processed,
      parsed: state.ocrCurrent.parsed,
      skipped: state.ocrCurrent.skipped,
      failed: state.ocrCurrent.failed,
      code: 'ocr_stopped',
      message: '识别已停止。',
      kind: 'warn',
      done: true,
    });
  }
  if (opts.progress && code !== 0) {
    state.emitFetch({
      percent: 100,
      matched: state.current.seen,
      saved: state.current.saved,
      skipped: state.current.skipped,
      step: '失败',
      code: 'fetch_failed',
      message: '抓取失败，请检查邮箱配置后重试。',
      detail,
      kind: 'err',
      done: true,
    });
  }
  if (opts.operation === 'ocr' && code !== 0 && !stopped) {
    state.emitOcr({
      operation: 'ocr',
      phase: '识别失败',
      percent: 100,
      total: state.ocrCurrent.total,
      processed: state.ocrCurrent.processed,
      parsed: state.ocrCurrent.parsed,
      skipped: state.ocrCurrent.skipped,
      failed: state.ocrCurrent.failed,
      code: 'ocr_failed',
      // COPY-10：识别失败原因多样（服务/凭据/解析），勿默认归咎磁盘。
      message: '无法完成识别。请稍后重试；若连续失败，请到「设置」检查识别相关选项，并展开「查看技术详情」。',
      detail,
      kind: 'err',
      done: true,
    });
  }
  // 非 0 且未收到 Run complete 终态时补发失败事件（有终态时 parseFileLine 已发）。
  if (opts.operation === 'files' && code !== 0 && !runCounts) {
    state.emitFiles({
      operation: 'files',
      phase: '获取失败',
      percent: 100,
      ...(state.fileCurrent.total > 0 ? { total: state.fileCurrent.total } : {}),
      processed: state.fileCurrent.processed,
      skipped: state.fileCurrent.skipped,
      failed: state.fileCurrent.failed,
      code: 'files_failed',
      // COPY-10：勿默认说成保存位置问题。
      message: '获取发票文件没有完成。请先重试；若仍失败，请展开「查看技术详情」或检查网络与邮箱设置。',
      detail,
      kind: 'err',
      done: true,
    });
  }
  resolve({
    code,
    stdout: out,
    stderr: err,
    started: true,
    mails: state.mails(),
    ...(runCounts ? { runCounts } : {}),
    ...(ocrCounts ? { ocrCounts } : {}),
    ...(state.capturedTerminalMailNotFound ? { terminalMailNotFound: true } : {}),
  });
}

export function createCliRunner(deps: CliRunnerDependencies) {
  const {
    rootDir,
    dataDir,
    coordinator,
    getDevBackend,
    readConfigForPaths,
    activeChildren,
    ocrProcesses,
    ocrStopRequested,
    sendProgress,
    sendOperationProgress,
    sendFileProgress,
  } = deps;

function runCli(command: string, args: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  return new Promise((resolve) => {
    const state = createRunState(opts, sendProgress, sendOperationProgress, sendFileProgress);

    const devBackend = getDevBackend();
    if (devBackend) {
      runFakeCli(devBackend, command, args, opts, dataDir, readConfigForPaths, state, resolve);
      return;
    }

    const child = spawnCli(command, args, rootDir, dataDir, coordinator, activeChildren);
    // 有界的诊断输出：只保留最后 500 行，长任务不再让主进程内存无限增长。
    const streams: OutputStreams = {
      stdoutTail: new LineRingBuffer(500),
      stderrTail: new LineRingBuffer(500),
      stdoutLines: new LineAssembler(),
      stderrLines: new LineAssembler(),
    };

    if (opts.operation === 'ocr' && opts.jobId) {
      // 不覆盖已有句柄：协调器保证同一时刻只有一个 OCR，这里再兜一层。
      ocrProcesses.set(opts.jobId, child);
    }

    if (opts.progress) {
      state.emitFetch({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', code: 'fetch_phase', message: '正在连接邮箱并搜索邮件。' });
    } else if (opts.operation === 'ocr') {
      state.ocrCurrent.initialized = true;
      sendOcrPhase('正在调用本机识别引擎。', state.emitOcr, state.ocrCurrent);
    } else if (opts.operation === 'files') {
      sendFilePhase('正在从本地邮件中获取发票文件。', state.emitFiles, state.fileCurrent);
    }

    attachOutputStreams(child, opts, state, streams);

    const settlement: SettlementState = { settled: false };
    child.on('error', (err) => {
      emitProcessFailure(err, child, opts, state, settlement, activeChildren, ocrProcesses, resolve);
    });

    child.on('close', (code) => {
      finalizeCliResult(
        code,
        child,
        opts,
        state,
        streams,
        settlement,
        activeChildren,
        ocrProcesses,
        ocrStopRequested,
        resolve,
      );
    });
  });
}

  return { runCli };
}
