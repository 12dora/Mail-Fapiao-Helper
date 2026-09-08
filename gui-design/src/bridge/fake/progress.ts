/** 假任务的进度帧。抽出来只是为了让 fake/index.ts 里的每个方法都读得完。 */
import type { FetchProgress, FileProgress, OcrFailureReason, OperationProgress } from '../types.js';

export function fetchFrames(dryRun: boolean): FetchProgress[] {
  return [
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
      message: dryRun ? '试运行完成，未下载邮件' : '已完成，新增 18 封邮件',
      kind: 'success',
      done: true,
    },
  ];
}

export function fileFrames(): FileProgress[] {
  return [
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
}

export interface OcrFrameOptions {
  /** 只重试失败项：队列里只剩失败的那几份，文案与帧数都要跟着变。 */
  retryFailed?: boolean;
  /** 收尾帧要带回的失败原因，主进程只给前 3 条。 */
  failureReasons?: OcrFailureReason[];
}

/** 只重试失败项时的进度帧：队列短，收尾时不再有失败。 */
function retryFrames(total: number): OperationProgress[] {
  const half = Math.max(1, Math.ceil(total / 2));
  return [
    {
      operation: 'ocr',
      phase: 'queue',
      percent: 18,
      total,
      message: `队列中 ${total} 份上次失败的文件`,
      kind: 'info',
      done: false,
    },
    {
      operation: 'ocr',
      phase: 'recognize',
      percent: 64,
      total,
      processed: half,
      parsed: half,
      message: `已重试 ${half} 份`,
      kind: 'info',
      done: false,
    },
    {
      operation: 'ocr',
      phase: 'done',
      percent: 100,
      total,
      processed: total,
      parsed: total,
      failed: 0,
      message: `已完成，重试 ${total} 份，全部识别成功`,
      kind: 'success',
      done: true,
    },
  ];
}

export function ocrFrames(options: OcrFrameOptions = {}): OperationProgress[] {
  const reasons = options.failureReasons ?? [];
  const failed = reasons.reduce((n, item) => n + item.count, 0);
  if (options.retryFailed) return retryFrames(Math.max(1, failed));
  return [
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
      ...(reasons.length > 0 ? { failureReasons: reasons } : {}),
    },
  ];
}
