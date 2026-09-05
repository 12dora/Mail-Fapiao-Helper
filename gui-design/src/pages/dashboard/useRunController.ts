/**
 * 「开始处理」这一次运行的全部状态：时间范围、匹配开关、三段任务的进度与日志。
 *
 * 状态本身在 store/run.ts 与 bridge 的通道 store 里（都是模块级），这个 hook 只
 * 负责把它们读出来拼成页面用的形状：运行是一串 await，用户中途切页再回来，看到
 * 的必须还是同一次运行的日志和结果。这里不产生任何 JSX。
 */
import { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { bridge, primeSummary, reloadSummary, useProgress } from '../../bridge/index.js';
import type { BatchRow, LogLine, RunningOp } from '../../bridge/index.js';
import { notify, notifyResult, useBusy } from '../../components/index.js';
import { appendRunNote, getRunState, patchRun, subscribeRun, type RangePreset } from '../../store/run.js';

export { RANGE_OPTIONS, rangeFor } from '../../store/run.js';
export type { RangePreset } from '../../store/run.js';

/** 进度事件的 phase 只在日志里有意义，进度条旁边显示一句人话。 */
const PHASE_TEXT: Record<string, string> = {
  connect: '连接邮箱',
  search: '搜索邮件',
  download: '保存邮件',
  scan: '扫描邮件',
  queue: '准备识别队列',
  recognize: '识别发票',
  done: '已完成',
};

export interface RunController {
  preset: RangePreset;
  setPreset(next: RangePreset): void;
  range: [Dayjs, Dayjs];
  setRange(next: [Dayjs, Dayjs]): void;
  matchSubject: boolean;
  setMatchSubject(next: boolean): void;
  matchBody: boolean;
  setMatchBody(next: boolean): void;
  dryRun: boolean;
  setDryRun(next: boolean): void;
  busy: boolean;
  running: RunningOp | null;
  batch: BatchRow[];
  logLines: LogLine[];
  percent: number;
  /** 进度条下面那一行：运行中说当前这一步，空闲时说上一次的结果。 */
  statusText: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 一次运行的三段任务。定义在组件外：它只读写 store，不碰任何组件状态，
 * 所以页面卸载不影响它跑完，也不会把结果写到一个已经不存在的组件上。
 */
async function runOnce(): Promise<void> {
  const { range, matchSubject, matchBody, dryRun } = getRunState();
  appendRunNote(dryRun ? '开始试运行' : '开始处理');
  const fetched = await bridge.startFetch({
    from: range[0].format('YYYY-MM-DD'),
    to: range[1].format('YYYY-MM-DD'),
    matchSubject,
    matchBody,
    dryRun,
  });
  patchRun({ batch: fetched.batch?.rows ?? [] });
  primeSummary(fetched.summary);
  if (!fetched.ok) {
    notifyResult(fetched, { success: '已完成', failure: '获取邮件未完成' });
    return;
  }
  if (dryRun) {
    notify.success('试运行完成', fetched.message ?? '未下载任何邮件。');
    return;
  }

  const files = await bridge.runPipeline({});
  primeSummary(files.summary);
  if (!files.ok) {
    notifyResult(files, { success: '已完成', failure: '获取发票文件未完成' });
    return;
  }

  const ocr = await bridge.runOcr({});
  primeSummary(ocr.summary);
  if (ocr.code === 'ocr_no_work') appendRunNote('没有待识别的文件');
  notifyResult(ocr.ok ? files : ocr, { success: '处理完成', failure: '识别未完成' });
}

async function start(): Promise<void> {
  const { matchSubject, matchBody } = getRunState();
  if (!matchSubject && !matchBody) {
    notify.warning('至少选择一个匹配范围', '主题和正文需要勾选其中一项。');
    return;
  }
  try {
    await runOnce();
  } finally {
    // 每条退出路径（含失败与试运行）都补一次：终态带回的 summary 是截断过的。
    await reloadSummary();
  }
}

async function stop(): Promise<void> {
  const result = await bridge.stopOcr();
  notifyResult(result, { success: '正在停止', failure: '停止失败' });
}

export function useRunController(): RunController {
  const { busy, running } = useBusy();
  const fetchProgress = useProgress('fetch');
  const fileProgress = useProgress('files');
  const ocrProgress = useProgress('ocr');
  const run = useSyncExternalStore(subscribeRun, getRunState, getRunState);

  /** 三路进度事件加本地提示，按时间戳合并成一条日志流。 */
  const logLines = useMemo(() => {
    const merged = [...run.notes, ...fetchProgress.lines, ...fileProgress.lines, ...ocrProgress.lines];
    return merged.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }, [run.notes, fetchProgress.lines, fileProgress.lines, ocrProgress.lines]);

  // 任务结束后 running 变回 null，但进度条与说明要停在最后跑过的那一步上。
  useEffect(() => {
    if (running) patchRun({ lastKind: running.kind });
  }, [running]);

  const shownKind = running?.kind ?? run.lastKind;
  const active = shownKind === 'ocr' ? ocrProgress : shownKind === 'pipeline' ? fileProgress : fetchProgress;
  const phase = PHASE_TEXT[active.phase] ?? '';

  return {
    preset: run.preset,
    setPreset: (preset) => patchRun({ preset }),
    range: run.range,
    setRange: (range) => patchRun({ range }),
    matchSubject: run.matchSubject,
    setMatchSubject: (matchSubject) => patchRun({ matchSubject }),
    matchBody: run.matchBody,
    setMatchBody: (matchBody) => patchRun({ matchBody }),
    dryRun: run.dryRun,
    setDryRun: (dryRun) => patchRun({ dryRun }),
    busy,
    running,
    batch: run.batch,
    logLines,
    percent: active.percent,
    statusText: busy ? `${phase || '处理中'}…` : active.latest?.message || '尚未运行',
    start,
    stop,
  };
}
