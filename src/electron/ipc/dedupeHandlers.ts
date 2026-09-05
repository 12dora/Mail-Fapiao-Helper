import fs from 'node:fs';
import path from 'node:path';
import { deriveRunStatus } from '../cliProtocol.js';
import { asObject } from '../payload.js';
import { sanitizeText } from '../sanitize.js';
import type { OperationHandlerDependencies } from './operationHandlers.js';

export type DedupeHandlerDependencies = Pick<OperationHandlerDependencies,
  | 'handleTrusted' | 'acquireOperation' | 'ensureArchiveRecoveryReady'
  | 'dataDir' | 'configPath' | 'runCli' | 'recordHistory' | 'reportFor'
  | 'tryAppSummary' | 'appSummary'
>;

export interface DedupeReport {
  mode: 'container' | 'invoice-no';
  applied: boolean;
  quarantineDir: string | null;
  pairs: number;
  redundant: number;
  quarantined: number;
  ledgerRowsRemoved: number;
  ocrRowsRemoved: number;
  recovered?: number;
  groups: {
    invoiceNo: string;
    kept: { filename: string; date: string; seller: string; amount: string; format: string };
    removed: { filename: string; date: string; seller: string; amount: string; format: string; reason: string }[];
    conflict: boolean;
    conflictReason: string;
  }[];
  conflicts: number;
  skipped: { filename: string; reason: string }[];
}

/** CLI 日志前后可有普通文本；只接受最后一份完整 JSON 对象报告。 */
export function parseDedupeReport(stdout: string): DedupeReport | null {
  let last: unknown;
  for (let start = 0; start < stdout.length; start++) {
    if (stdout[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < stdout.length; end++) {
      const char = stdout[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          last = JSON.parse(stdout.slice(start, end + 1));
          start = end;
        } catch { /* 普通日志中的花括号不是报告。 */ }
        break;
      }
    }
  }
  return validateDedupeReport(last);
}

function validateDedupeReport(value: unknown): DedupeReport | null {
  const row = asObject(value);
  const counters = ['pairs', 'redundant', 'quarantined', 'ledgerRowsRemoved', 'ocrRowsRemoved', 'conflicts'];
  if ((row.mode !== 'container' && row.mode !== 'invoice-no') || typeof row.applied !== 'boolean'
    || (row.quarantineDir !== null && typeof row.quarantineDir !== 'string')
    || !counters.every((key) => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)
    || (row.recovered !== undefined && (!Number.isSafeInteger(row.recovered) || Number(row.recovered) < 0))
    || !Array.isArray(row.groups) || !Array.isArray(row.skipped)) return null;
  return row as unknown as DedupeReport;
}

function readDedupeReport(file: string, stdout: string): DedupeReport | null {
  try {
    const report = validateDedupeReport(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (report) return report;
  } catch { /* 兼容尚未写报告文件的 CLI，也允许损坏文件回退到 stdout。 */ }
  return parseDedupeReport(stdout);
}

function projectDedupeReport(report: DedupeReport, dataDir: string): DedupeReport {
  let quarantineDir: string | null = null;
  if (report.quarantineDir !== null) {
    const relative = path.relative(dataDir, path.resolve(dataDir, report.quarantineDir));
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    quarantineDir = outside ? '' : relative.split(path.sep).join('/') || '.';
  }
  return {
    ...report,
    quarantineDir,
    skipped: report.skipped.map((row) => ({ ...row, reason: sanitizeText(row.reason) })),
  };
}

export function registerDedupeHandlers(deps: DedupeHandlerDependencies): void {
  const {
    handleTrusted, acquireOperation, ensureArchiveRecoveryReady, dataDir, configPath,
    runCli, recordHistory, reportFor, tryAppSummary, appSummary,
  } = deps;
  handleTrusted('mfh:dedupe', async (_event, payload: unknown) => {
    const raw = asObject(payload);
    if ((raw.by !== 'invoice-no' && raw.by !== 'container') || typeof raw.apply !== 'boolean') {
      return { ok: false, status: 'failed', started: false, jobId: '', code: 'invalid_dedupe_options',
        message: '清理选项无效，请重新选择。', report: null };
    }
    const gate = acquireOperation('pipeline');
    if (!gate.ok) return { ...gate.response, status: 'failed', started: false, jobId: '', report: null };
    const jobId = gate.lease.jobId;
    const startedAt = Date.now();
    try {
      const recoveryError = ensureArchiveRecoveryReady();
      if (recoveryError) {
        return { ok: false, ...recoveryError, status: 'failed', started: false, jobId, report: null };
      }
      const reportFile = path.join(dataDir, '.mfh-cache', 'dedupe-report.json');
      // 持有操作租约后清掉旧报告，避免本次 CLI 失败时误读上一次成功结果。
      fs.rmSync(reportFile, { force: true });
      const result = await runCli('dedupe', [
        '--config', configPath, '--by', raw.by, ...(raw.apply ? ['--apply'] : []), '--json',
      ], { jobId });
      const rawReport = readDedupeReport(reportFile, result.stdout);
      const report = rawReport ? projectDedupeReport(rawReport, dataDir) : null;
      const status = deriveRunStatus({
        code: result.code,
        started: result.started,
        succeeded: report ? (raw.apply ? report.quarantined : report.redundant) : 0,
        failed: !report || result.code !== 0 ? 1 : 0,
        partial: report ? report.conflicts + report.skipped.length : 0,
      });
      const message = status === 'success'
        ? (raw.apply ? '重复发票清理完成。' : '重复发票检查完成。')
        : status === 'partial'
          ? '部分发票未能清理，请查看清理结果。'
          : '重复发票清理未完成，请查看诊断信息。';
      const historyWarning = recordHistory('dedupe', '清理重复发票', startedAt, result, status, message);
      const cliReport = reportFor('dedupe', jobId, result,
        { ok: 'dedupe_done', failed: 'dedupe_failed', partial: 'dedupe_partial' }, status);
      const summaryPart = tryAppSummary(appSummary);
      const warning = [historyWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
      return {
        ok: status === 'success', status, started: result.started, ...cliReport, jobId, message, report,
        ...(warning ? { warning } : {}),
        ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
        ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
      };
    } finally {
      gate.lease.release();
    }
  });
}
