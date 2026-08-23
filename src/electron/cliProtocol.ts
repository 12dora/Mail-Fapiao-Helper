import { sanitizeText } from './sanitize.js';
import type { RunHistoryEntry } from './summary.js';

export type ProgressSink = (data: Record<string, unknown>) => void;

/**
 * 终态事件只允许发一次（APP-23）：解析到 `done: true` 之后的后续事件全部丢弃，
 * 这样 exit result 补发的终态不会和行解析出的终态重复。
 */
export function terminalGuard(send: ProgressSink): ProgressSink {
  let done = false;
  return (data) => {
    if (done) return;
    if (data.done === true) done = true;
    send(data);
  };
}

/** 去掉 CLI 日志行首的 `[info] 2026-.. ` 前缀，再统一脱敏。 */
export function logText(line: string): string {
  return sanitizeText(line.replace(/^\[(info|warn|error|debug)\]\s+\S+\s+/, ''), { maxLength: 240 });
}

/**
 * 从 `key=value` 形态的 CLI 汇总行里按字段名取数。CLI 会在汇总行里增删字段
 * （例如 fetch 新增了 `repaired=`、run 新增了 `partial=`），逐字段解析可以避免
 * 「多了一个字段就整条终态行不再匹配」——那正好会让 APP-23 修好的终态事件重新丢失。
 */
export function numField(text: string, key: string): number | undefined {
  const match = new RegExp(`\\b${key}=(\\d+)\\b`).exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * CLI 日志里的邮件身份（HASH-WIDTH / CORE-03）：
 * - 历史 12 位 sha1 前缀（无 raw）
 * - 有 raw 时 32 位 sha256 前缀（128 bit）
 * 这些行是主进程能拿到的、逐封邮件的**真实**信号，用来拼「本次抓取 / 本次运行」
 * 的批次明细（APP-20）——而不是去 INDEX 里取最后 N 行。
 */
export const MAIL_HASH_BODY = '([0-9a-f]{12}|[0-9a-f]{32})';
export const SAVED_MAIL_RE = new RegExp(`\\bsaved ${MAIL_HASH_BODY}\\b`);
export const PROCESSED_MAIL_RE = new RegExp(`\\bProcessed ${MAIL_HASH_BODY}:`);
export const MANUAL_MAIL_RE = new RegExp(`\\bManual ${MAIL_HASH_BODY}:`);
/** IPC / 路径拼接用的裸 hash 校验：只接受 12 或 32 位小写十六进制（ELEC-06）。 */
export const BARE_MAIL_HASH_RE = /^[0-9a-f]{12}$|^[0-9a-f]{32}$/;

export function parseMailHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hash = value.trim().toLowerCase();
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  return hash;
}

export interface FetchProgressState {
  seen: number;
  saved: number;
  skipped: number;
  repaired: number;
}

export interface OcrProgressState {
  total: number;
  parsed: number;
  failed: number;
  skipped: number;
  processed: number;
  initialized: boolean;
}

export interface FileProgressState {
  /** 已知待处理总数（来自 Queued N）；未知时为 0，不发假 percent（FE-12-BACKEND）。 */
  total: number;
  /** handled = archived + pending（兼容旧 processed 字段）。 */
  processed: number;
  archived: number;
  pending: number;
  skipped: number;
  failed: number;
  /** archived 子集：有票落盘但仍有待确认。 */
  partial: number;
}

/** CLI `Run complete:` 结构化计数（簇 C 契约）。 */
export interface RunTerminalCounts {
  archived: number;
  pending: number;
  skipped: number;
  failed: number;
  /** archived 子集。 */
  partial: number;
  /** archived + pending（兼容旧 processed=）。 */
  processed: number;
}

export function emptyRunCounts(): RunTerminalCounts {
  return { archived: 0, pending: 0, skipped: 0, failed: 0, partial: 0, processed: 0 };
}

/**
 * 去掉 CLI 可信日志信封后的逻辑行。信封本身由 logger 写入、不可由附件文件名伪造
 * （CORE-13：不可信值不会出现在行首，换行已转义）。
 */
export function stripCliLogEnvelope(line: string): string {
  return line.replace(/^\[(info|warn|error|debug)\]\s+\S+\s+/, '');
}

/**
 * 终端摘要契约：只认「逻辑行首」锚定的 `Run complete:` / `OCR complete:` / `Organize complete:`，
 * 逐行扫描，取**最后**一条匹配（中间夹带同名子串的附件名不能伪造）。
 * 兼容 `\\x1eMFH_TERMINAL\\x1e` 增强锚定通道与 `[info] ts …` 日志信封。
 */
export function lastAnchoredTerminalLine(output: string, marker: string): string | undefined {
  let found: string | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const body = logicalTerminalLine(raw);
    if (body.startsWith(marker)) found = body;
  }
  return found;
}

/** 从 stdout/stderr 解析行首锚定的 `Run complete: archived=…`（也兼容旧 processed=）。 */
export function parseRunCompleteCounts(output: string): RunTerminalCounts | undefined {
  const line = lastAnchoredTerminalLine(output, 'Run complete:');
  if (!line) return undefined;
  const archived = numField(line, 'archived');
  const pending = numField(line, 'pending');
  const skipped = numField(line, 'skipped') ?? 0;
  const failed = numField(line, 'failed') ?? 0;
  const partial = numField(line, 'partial') ?? 0;
  const processedField = numField(line, 'processed');
  // 新格式优先；旧格式只有 processed= 时把它当作 archived+pending 合计。
  if (archived !== undefined || pending !== undefined) {
    const a = archived ?? 0;
    const p = pending ?? 0;
    return {
      archived: a,
      pending: p,
      skipped,
      failed,
      partial,
      processed: processedField ?? (a + p),
    };
  }
  if (processedField !== undefined) {
    return {
      archived: processedField,
      pending: 0,
      skipped,
      failed,
      partial,
      processed: processedField,
    };
  }
  return undefined;
}

export function parseOcrCompleteCounts(output: string): {
  scanned: number;
  parsed: number;
  skipped: number;
  failed: number;
  updated: number;
} | undefined {
  const line = lastAnchoredTerminalLine(output, 'OCR complete:');
  if (!line) return undefined;
  const match = /^OCR complete:\s*scanned=(\d+),\s*parsed=(\d+),\s*skipped=(\d+),\s*failed=(\d+),\s*updated=(\d+)/.exec(line);
  if (!match) return undefined;
  return {
    scanned: Number(match[1]),
    parsed: Number(match[2]),
    skipped: Number(match[3]),
    failed: Number(match[4]),
    updated: Number(match[5]),
  };
}

export function parseOrganizeCompleteCounts(output: string): {
  scanned: number;
  copied: number;
  skipped: number;
  failed: number;
} | undefined {
  const line = lastAnchoredTerminalLine(output, 'Organize complete:');
  if (!line) return undefined;
  const match = /^Organize complete:\s*scanned=(\d+),\s*copied=(\d+),\s*skipped=(\d+),\s*failed=(\d+)/.exec(line);
  if (!match) {
    // 至少拿到 scanned= 时仍返回，其余字段默 0
    const scanned = numField(line, 'scanned');
    if (scanned === undefined) return undefined;
    return {
      scanned,
      copied: numField(line, 'copied') ?? 0,
      skipped: numField(line, 'skipped') ?? 0,
      failed: numField(line, 'failed') ?? 0,
    };
  }
  return {
    scanned: Number(match[1]),
    copied: Number(match[2]),
    skipped: Number(match[3]),
    failed: Number(match[4]),
  };
}

/** 解析 fetch 的 `done: seen=…` 终态行（行首锚定，取最后一条）。 */
export function parseFetchDoneCounts(output: string): {
  seen: number;
  saved: number;
  skippedKnown: number;
  repaired: number;
  dryRun: boolean;
} | undefined {
  const line = lastAnchoredTerminalLine(output, 'done:');
  if (!line || !/\bseen=\d+/.test(line)) return undefined;
  return {
    seen: numField(line, 'seen') ?? 0,
    saved: numField(line, 'saved') ?? 0,
    skippedKnown: numField(line, 'skippedKnown') ?? 0,
    repaired: numField(line, 'repaired') ?? 0,
    dryRun: /\bdryRun=true\b/.test(line),
  };
}

/**
 * 运行历史 / IPC 终态：success | partial | failed。
 * - 有成功侧也有失败 → partial
 * - partial 计数 > 0（如 archived 子集仍有待确认）→ partial
 * - 仅失败 / 未启动 / 非 0 且无成功 → failed
 * - 仅成功（含 skipped）→ success
 */
export function deriveRunStatus(opts: {
  code: number | null;
  started?: boolean;
  succeeded: number;
  failed: number;
  /** archived 子集：有结果但仍不完整；>0 时不得标 green success。 */
  partial?: number;
  mailNotFound?: boolean;
}): RunHistoryEntry['status'] {
  if (opts.started === false) return 'failed';
  if (opts.mailNotFound) return 'failed';
  if (opts.failed > 0 && opts.succeeded > 0) return 'partial';
  if (opts.failed > 0) return 'failed';
  if ((opts.partial ?? 0) > 0) return 'partial';
  if (opts.code !== 0 && opts.code !== null) {
    // 非 0 退出但已有成功侧 → 部分完成，而非整次失败
    if (opts.succeeded > 0) return 'partial';
    return 'failed';
  }
  return 'success';
}

export function parseFetchLine(line: string, current: FetchProgressState, emit: ProgressSink): void {
  const body = stripCliLogEnvelope(line.trim());
  // 行首锚定 `done:`，禁止附件名/主题里的同名子串伪造终态。
  if (body.startsWith('done:') && /\bseen=\d+/.test(body)) {
    current.seen = numField(body, 'seen') ?? current.seen;
    current.saved = numField(body, 'saved') ?? current.saved;
    current.skipped = numField(body, 'skippedKnown') ?? current.skipped;
    current.repaired = numField(body, 'repaired') ?? current.repaired;
    const dryRun = /\bdryRun=true\b/.test(body);
    const repairedNote = current.repaired > 0 ? `，修复 ${current.repaired} 封缓存缺失的邮件` : '';
    emit({
      percent: 100,
      matched: current.seen,
      saved: current.saved,
      skipped: current.skipped,
      repaired: current.repaired,
      dryRun,
      step: '完成',
      code: dryRun ? 'fetch_preview_done' : 'fetch_done',
      message: dryRun
        ? `预览完成：命中 ${current.seen} 封邮件，本次没有写入本机（预览模式）。`
        : `已保存 ${current.saved} 封新邮件，跳过 ${current.skipped} 封已缓存邮件${repairedNote}。`,
      kind: 'ok',
      done: true,
    });
    return;
  }
  if (SAVED_MAIL_RE.test(line)) {
    current.saved++;
    current.seen = Math.max(current.seen, current.saved + current.skipped);
    emit({
      percent: Math.min(92, 20 + current.saved * 3),
      matched: current.seen,
      saved: current.saved,
      skipped: current.skipped,
      step: '保存',
      code: 'fetch_saved',
      message: '已保存一封相关邮件到本机缓存。',
    });
  }
}

export function parseOcrTerminal(text: string, current: OcrProgressState, emit: ProgressSink): boolean {
  // 行首锚定，禁止子串伪造
  const complete = text.startsWith('OCR complete:')
    ? /^OCR complete:\s*scanned=(\d+),\s*parsed=(\d+),\s*skipped=(\d+),\s*failed=(\d+),\s*updated=(\d+)/.exec(text)
    : null;
  if (complete) {
    current.total = Number(complete[1]);
    current.parsed = Number(complete[2]);
    current.skipped = Number(complete[3]);
    current.failed = Number(complete[4]);
    current.processed = current.parsed + current.skipped + current.failed;
    const status = deriveRunStatus({
      code: current.failed > 0 ? 1 : 0,
      succeeded: current.parsed + current.skipped,
      failed: current.failed,
    });
    let message: string;
    let kind: string;
    let phase: string;
    if (current.total === 0) {
      phase = '没有文件';
      kind = 'warn';
      message = '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。';
    } else if (status === 'success') {
      phase = '识别完成';
      kind = 'ok';
      message = `识别完成：成功 ${current.parsed} 个，跳过 ${current.skipped} 个。`;
    } else if (status === 'partial') {
      phase = '部分完成';
      kind = 'warn';
      message = `识别部分完成：成功 ${current.parsed} 个，失败 ${current.failed} 个，跳过 ${current.skipped} 个。`;
    } else {
      phase = '识别失败';
      kind = 'err';
      message = `识别没有完成：失败 ${current.failed} 个。请稍后重试；若仍失败，请到「设置」检查识别选项。`;
    }
    emit({
      operation: 'ocr',
      phase,
      percent: 100,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      status,
      code: status === 'success' ? 'ocr_done' : status === 'partial' ? 'ocr_partial' : 'ocr_failed',
      message,
      kind,
      done: true,
    });
    return true;
  }
  return false;
}

export function parseOcrSuccess(text: string, current: OcrProgressState, emit: ProgressSink): boolean {
  const parsed = /OCR parsed (.+)$/.exec(text);
  if (parsed) {
    current.parsed++;
    current.processed++;
    emit({
      operation: 'ocr',
      phase: '正在识别',
      percent: current.total > 0 ? Math.min(96, Math.round((current.processed / current.total) * 100)) : undefined,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'ocr_item_ok',
      message: `识别成功：${sanitizeText(parsed[1] ?? '', { maxLength: 120 })}`,
      kind: 'ok',
    });
    return true;
  }
  return false;
}

export function parseOcrFailure(text: string, current: OcrProgressState, emit: ProgressSink): boolean {
  const failed = /OCR failed (.+?)(?:: (.*))?$/.exec(text);
  if (failed) {
    current.failed++;
    current.processed++;
    const detail = failed[2] ? sanitizeText(failed[2], { maxLength: 200 }) : '';
    emit({
      operation: 'ocr',
      phase: '正在识别',
      percent: current.total > 0 ? Math.min(96, Math.round((current.processed / current.total) * 100)) : undefined,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'ocr_item_failed',
      message: `识别失败：${sanitizeText(failed[1] ?? '', { maxLength: 120 })}`,
      detail,
      kind: 'warn',
    });
    return true;
  }
  return false;
}

export function parseOcrDiagnostic(text: string, current: OcrProgressState, emit: ProgressSink): void {
  // COPY-06：未映射的原始 CLI 行不进普通识别日志；仅发稳定 code。
  if (text.includes('[error]') || text.includes('[warn]')) {
    emit({
      operation: 'ocr',
      phase: '识别日志',
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      code: text.includes('[error]') ? 'ocr_log_error' : 'ocr_log_warn',
      message: text.includes('[error]')
        ? '识别过程中出现错误，详情见技术诊断。'
        : '识别过程中出现警告，详情见技术诊断。',
      kind: text.includes('[error]') ? 'err' : 'warn',
    });
  }
}

export function parseOcrLine(line: string, current: OcrProgressState, emit: ProgressSink): void {
  const text = stripCliLogEnvelope(line.trim());
  if (!text) return;
  if (parseOcrTerminal(text, current, emit)) return;
  if (parseOcrSuccess(text, current, emit)) return;
  if (parseOcrFailure(text, current, emit)) return;
  parseOcrDiagnostic(text, current, emit);
}

/** FE-12：未知 total 时不发假 percent。 */
export function sendOcrPhase(message: string, emit: ProgressSink, current?: Partial<OcrProgressState>, kind = ''): void {
  const total = current?.total ?? 0;
  emit({
    operation: 'ocr',
    phase: '准备识别',
    ...(total > 0 ? { total, percent: 1 } : { total: 0 }),
    processed: current?.processed ?? 0,
    parsed: current?.parsed ?? 0,
    skipped: current?.skipped ?? 0,
    failed: current?.failed ?? 0,
    code: 'ocr_phase',
    message,
    kind,
  });
}

/** 有 total 时给真实 percent；未知 total 时不发 percent，让 renderer 走不确定进度（FE-12）。 */
export function fileProgressPercent(current: FileProgressState): number | undefined {
  if (current.total <= 0) return undefined;
  const done = current.processed + current.skipped + current.failed;
  return Math.min(95, Math.max(1, Math.round((done / current.total) * 100)));
}

/**
 * 终态行上的未命中/失败标记（C6）：CLI 在 `Run complete:` 同行携带
 * `mail_not_found` / `outcome=mail_not_found|failed` 时，直播进度必须立刻标失败，
 * 不得先闪绿色零计数成功再等 process-close 翻盘。
 */
export function terminalLineFailureMarkers(text: string): { mailNotFound: boolean; forcedFail: boolean } {
  const mailNotFound = /\bmail_not_found\b/i.test(text)
    || /\boutcome\s*=\s*mail_not_found\b/i.test(text);
  const outcomeFailed = /\boutcome\s*=\s*failed\b/i.test(text);
  return { mailNotFound, forcedFail: mailNotFound || outcomeFailed };
}

/** 去掉 CLI 日志信封与 MFH 终态锚定前缀，得到可供 startsWith 判定的逻辑行。 */
export function logicalTerminalLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  const unwrapped = stripCliLogEnvelope(trimmed);
  return unwrapped.replace(/^\x1eMFH_TERMINAL\x1e\s*/, '');
}

export function parseFileTerminal(text: string, current: FileProgressState, emit: ProgressSink): boolean {
  // 行首锚定 `Run complete:`（禁止附件文件名里的同名子串伪造终态）
  if (text.startsWith('Run complete:')) {
    const counts = parseRunCompleteCounts(text);
    if (counts) {
      current.archived = counts.archived;
      current.pending = counts.pending;
      current.processed = counts.processed;
      current.skipped = counts.skipped;
      current.failed = counts.failed;
      current.partial = counts.partial;
    } else {
      current.processed = numField(text, 'processed') ?? current.processed;
      current.skipped = numField(text, 'skipped') ?? current.skipped;
      current.failed = numField(text, 'failed') ?? current.failed;
      current.partial = numField(text, 'partial') ?? current.partial;
    }
    const markers = terminalLineFailureMarkers(text);
    const status = deriveRunStatus({
      code: markers.forcedFail || current.failed > 0 ? 1 : 0,
      succeeded: current.archived + current.pending + current.skipped,
      failed: current.failed + (markers.forcedFail ? 1 : 0),
      partial: current.partial,
      mailNotFound: markers.mailNotFound,
    });
    const partialNote = current.partial > 0 ? `，其中 ${current.partial} 封仍有待确认` : '';
    const pendingNote = current.pending > 0 ? `，待确认 ${current.pending} 封` : '';
    let message: string;
    let kind: string;
    let phase: string;
    if (markers.mailNotFound) {
      phase = '获取失败';
      kind = 'err';
      message = '没有找到这封待处理邮件。请刷新「待确认」列表后再试。';
    } else if (status === 'success') {
      phase = '获取完成';
      kind = 'ok';
      message = `处理完成：成功 ${current.archived} 封${pendingNote}${partialNote}，跳过 ${current.skipped} 封。`;
    } else if (status === 'partial') {
      phase = '部分完成';
      kind = 'warn';
      message = `已处理 ${current.archived + current.pending} 封邮件，其中 ${current.failed} 封没有完成${pendingNote}${partialNote}。请点击「重新获取」；如仍失败，请展开「查看技术详情」。`;
    } else {
      phase = '获取失败';
      kind = 'err';
      message = current.failed > 0
        ? `处理没有完成：失败 ${current.failed} 封。请先重试；如仍失败，请展开「查看技术详情」。`
        : '处理没有完成。请先重试；如仍失败，请展开「查看技术详情」。';
    }
    emit({
      operation: 'files',
      phase,
      percent: 100,
      total: current.total > 0
        ? current.total
        : current.archived + current.pending + current.skipped + current.failed,
      processed: current.processed,
      archived: current.archived,
      pending: current.pending,
      skipped: current.skipped,
      failed: current.failed,
      partial: current.partial,
      status,
      code: status === 'success' ? 'files_done' : status === 'partial' ? 'files_partial' : 'files_failed',
      message,
      kind,
      done: true,
      ...(markers.mailNotFound ? { mailNotFound: true } : {}),
    });
    return true;
  }
  return false;
}

export function parseQueued(text: string, current: FileProgressState, emit: ProgressSink): boolean {
  // CLI：`Queued N cached emails with concurrency=...` —— 已知总数时发 real total。
  const queued = /Queued (\d+) cached emails/.exec(text);
  if (queued) {
    current.total = Number(queued[1]) || 0;
    emit({
      operation: 'files',
      phase: '正在获取',
      ...(current.total > 0 ? { total: current.total, percent: 1 } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_queued',
      message: current.total > 0
        ? `准备处理 ${current.total} 封已保存邮件。`
        : '准备处理已保存的邮件。',
    });
    return true;
  }
  return false;
}

export function parseFileItem(text: string, current: FileProgressState, emit: ProgressSink): boolean {
  if (text.includes('Processed ')) {
    current.processed++;
    const percent = fileProgressPercent(current);
    emit({
      operation: 'files',
      phase: '正在获取',
      ...(percent !== undefined ? { percent } : {}),
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_item_ok',
      message: '已从一封邮件取得发票文件。',
      kind: 'ok',
    });
    return true;
  }

  if (text.includes('Skipped ')) {
    current.skipped++;
    const percent = fileProgressPercent(current);
    emit({
      operation: 'files',
      phase: '正在获取',
      ...(percent !== undefined ? { percent } : {}),
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_item_skipped',
      message: '跳过一封此前已处理的邮件。',
    });
    return true;
  }

  if (MANUAL_MAIL_RE.test(text)) {
    // 降级到待确认：计为进度完成的一部分，并推进 percent（FE-12）。
    current.processed++;
    const percent = fileProgressPercent(current);
    emit({
      operation: 'files',
      phase: '需要确认',
      ...(percent !== undefined ? { percent } : {}),
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_item_manual',
      message: '一封邮件暂时无法自动取得发票，已加入「待确认」。',
      kind: 'warn',
    });
    return true;
  }
  return false;
}

export function parseFileDiagnostic(text: string, current: FileProgressState, emit: ProgressSink): void {
  // 未识别的原始 CLI 行不进普通进度（COPY-06 / ELEC-07）；只保留稳定 code。
  // 原始内容只进诊断文件，不进 IPC。
  if (text.includes('[error]') || text.includes('[warn]')) {
    emit({
      operation: 'files',
      phase: text.includes('[warn]') ? '需要确认' : '获取日志',
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: text.includes('[error]') ? 'files_log_error' : 'files_log_warn',
      message: text.includes('[error]')
        ? '处理过程中出现错误，详情见技术诊断。'
        : '处理过程中出现警告，详情见技术诊断。',
      kind: text.includes('[error]') ? 'err' : 'warn',
    });
  }
}

export function parseFileLine(line: string, current: FileProgressState, emit: ProgressSink): void {
  const text = logicalTerminalLine(line);
  if (!text) return;
  if (parseFileTerminal(text, current, emit)) return;
  if (parseQueued(text, current, emit)) return;
  if (parseFileItem(text, current, emit)) return;
  parseFileDiagnostic(text, current, emit);
}

/** FE-12：未知 total 时不发 percent（不确定进度）；已知 total 时才带真实 percent。 */
export function sendFilePhase(message: string, emit: ProgressSink, current?: Partial<FileProgressState>, kind = ''): void {
  const total = current?.total ?? 0;
  emit({
    operation: 'files',
    phase: '准备获取',
    ...(total > 0 ? { total, percent: 1 } : {}),
    processed: current?.processed ?? 0,
    skipped: current?.skipped ?? 0,
    failed: current?.failed ?? 0,
    code: 'files_phase',
    message,
    kind,
  });
}
