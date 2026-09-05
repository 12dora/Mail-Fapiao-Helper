/** 假任务的进度帧。抽出来只是为了让 fake/index.ts 里的每个方法都读得完。 */
import type { FetchProgress, FileProgress, OperationProgress } from '../types.js';

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

export function ocrFrames(): OperationProgress[] {
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
    },
  ];
}
