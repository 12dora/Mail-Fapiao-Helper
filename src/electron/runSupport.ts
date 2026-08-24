import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseOcrCompleteCounts, type RunTerminalCounts } from './cliProtocol.js';
import type { RunCliResult } from './cliRunner.js';
import { dataDir } from './runtime.js';
import { sanitizeText } from './sanitize.js';
import { historyPath, type AppSummary, type RunHistoryEntry } from './summary.js';

// ---------------------------------------------------------------------------
// 诊断输出（COPY-01：原始日志只落到主进程受限的诊断文件，绝不进 IPC 返回值）
// ---------------------------------------------------------------------------

/** 保留的诊断文件数量上限，避免原始日志长期堆积在磁盘上。 */
export const DIAGNOSTICS_KEEP = 20;

export function diagnosticsDir(): string {
  return path.join(dataDir, '.mfh-cache', 'diagnostics');
}

export function pruneDiagnostics(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - DIAGNOSTICS_KEEP))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // best-effort
  }
}

/**
 * 把子进程原始 stdout/stderr 写进 0600 的诊断文件，返回**相对 dataDir** 的引用。
 * renderer 只拿到这个引用，可以经 `mfh:open-path`（有目录包含性校验）让用户显式
 * 打开；原始内容不会出现在 bridge 返回值、toast、剪贴板或运行历史里。
 */
export function writeDiagnostics(
  action: string,
  jobId: string,
  result: { stdout: string; stderr: string },
): string | undefined {
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  if (!raw) return undefined;
  try {
    const dir = diagnosticsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${action}-${stamp}-${jobId}.log`);
    const body = [
      `# action=${action} job=${jobId} time=${new Date().toISOString()}`,
      '# 本文件保留子进程原始输出，可能包含下载链接、令牌和本机路径，请勿直接分享。',
      '',
      '[stdout]',
      result.stdout,
      '',
      '[stderr]',
      result.stderr,
      '',
    ].join('\n');
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    pruneDiagnostics(dir);
    return path.relative(dataDir, file).split(path.sep).join('/');
  } catch {
    return undefined;
  }
}

/** IPC 返回值里与子进程结果相关的字段：只有 code / 已脱敏 detail / 诊断引用。 */
export interface CliReport {
  code: string;
  exitCode: number | null;
  detail?: string;
  diagnosticsRef?: string;
}

export function reportFor(
  action: string,
  jobId: string,
  result: RunCliResult,
  codes: { ok: string; failed: string; partial?: string },
  status: RunHistoryEntry['status'] = result.code === 0 ? 'success' : 'failed',
): CliReport {
  if (status === 'success') return { code: codes.ok, exitCode: result.code };
  const detail = sanitizeText(result.stderr.trim() || result.stdout.trim(), { maxLength: 400 });
  const diagnosticsRef = writeDiagnostics(action, jobId, result);
  const code = status === 'partial' && codes.partial
    ? codes.partial
    : codes.failed;
  return {
    code,
    exitCode: result.code,
    ...(detail ? { detail } : {}),
    ...(diagnosticsRef ? { diagnosticsRef } : {}),
  };
}

export function ocrRunMessage(result: RunCliResult): string {
  const counts = result.ocrCounts ?? parseOcrCompleteCounts(`${result.stdout}\n${result.stderr}`);
  if (!counts) return '已尝试识别本地文件。';
  if (counts.scanned === 0) {
    return '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。';
  }
  if (counts.failed > 0 && counts.parsed > 0) {
    return `识别部分完成：成功 ${counts.parsed} 个，失败 ${counts.failed} 个，跳过 ${counts.skipped} 个。`;
  }
  if (counts.failed > 0) {
    return `识别没有完成：失败 ${counts.failed} 个，跳过 ${counts.skipped} 个。`;
  }
  return `已扫描 ${counts.scanned} 个文件，识别成功 ${counts.parsed} 个，跳过 ${counts.skipped} 个。`;
}

export function pipelineRunMessage(
  counts: RunTerminalCounts,
  status: RunHistoryEntry['status'],
  onlyMail: boolean,
  mailNotFound: boolean,
): string {
  if (mailNotFound) {
    return onlyMail
      ? '没有找到这封待处理邮件。请刷新「待确认」列表后再试。'
      : '没有找到要处理的邮件。';
  }
  if (status === 'success') {
    if (onlyMail) {
      if (counts.pending > 0) return '这封邮件已重新处理，仍需在「待确认」中处理。';
      if (counts.archived > 0) return '这封邮件已重新处理。';
      if (counts.skipped > 0) return '这封邮件此前已处理，本次已跳过。';
      return '这封邮件已重新处理。';
    }
    const pendingNote = counts.pending > 0 ? `，其中 ${counts.pending} 封进入待确认` : '';
    return `处理完成，本次处理 ${counts.archived + counts.pending} 封邮件${pendingNote}。`;
  }
  if (status === 'partial') {
    if (counts.failed > 0) {
      return `已处理 ${counts.archived + counts.pending} 封邮件，其中 ${counts.failed} 封没有完成。请点击「重新获取」；如仍失败，请展开「查看技术详情」。`;
    }
    // partial 计数 > 0（有票落盘但仍有待确认子集）
    const partialNote = counts.partial > 0 ? `，其中 ${counts.partial} 封仍有待确认` : '';
    return `已处理 ${counts.archived + counts.pending} 封邮件${partialNote}。请到「待确认」继续处理。`;
  }
  if (onlyMail) {
    return '这封邮件没有处理完成。请稍后重试；如仍失败，请展开「查看技术详情」。';
  }
  return '处理缓存邮件没有完成。请先重试；如仍失败，请展开「查看技术详情」。';
}

// ---------------------------------------------------------------------------
// GUI 运行历史（APP-18B：best-effort + 原子写，绝不覆盖真实操作结果）
// ---------------------------------------------------------------------------

export function readHistorySafely(file: string): RunHistoryEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('history is not an array');
    return parsed as RunHistoryEntry[];
  } catch {
    // 损坏的历史文件隔离备份后重建，而不是让整个操作失败。
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best-effort
      }
    }
    return [];
  }
}

export function appendHistory(entry: Omit<RunHistoryEntry, 'id' | 'time'>): string | undefined {
  try {
    const file = historyPath(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next: RunHistoryEntry = {
      id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
      time: new Date().toISOString(),
      ...entry,
    };
    const history = [next, ...readHistorySafely(file)].slice(0, 30);
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return undefined;
  } catch {
    return '本次运行记录没有写入历史（不影响操作结果）。';
  }
}

/** 记录一条运行历史，返回非致命告警文案（写失败时）。status 必须由调用方按结构化计数推导（ELEC-12）。 */
export function recordHistory(
  action: string,
  title: string,
  startedAt: number,
  result: { code: number | null; stdout: string; stderr: string; started?: boolean },
  status: RunHistoryEntry['status'],
  message?: string,
): string | undefined {
  const output = sanitizeText(`${result.stdout}\n${result.stderr}`.trim(), { maxLength: 500 });
  const defaultMessage = status === 'success'
    ? '已完成'
    : status === 'partial'
      ? '部分完成'
      : '运行失败';
  return appendHistory({
    action,
    title,
    status,
    message: message ?? defaultMessage,
    detail: output || (status === 'success' ? '命令已完成。' : '没有收到错误详情。'),
    durationMs: Date.now() - startedAt,
  });
}

/** best-effort 摘要：失败时不覆盖已提交的操作结果（ELEC-08）。 */
export function tryAppSummary(appSummary: () => AppSummary): {
  summary?: AppSummary;
  summaryUnavailable?: boolean;
  warning?: string;
} {
  try {
    return { summary: appSummary() };
  } catch (err) {
    return {
      summaryUnavailable: true,
      warning: '操作已完成，但本地列表暂时无法刷新。请点击「刷新列表」。',
      // detail kept out of renderer-facing field; message is user-safe.
      ...(err instanceof Error ? {} : {}),
    };
  }
}
