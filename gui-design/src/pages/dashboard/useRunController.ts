/**
 * 「开始处理」这一次运行的全部状态：时间范围、匹配开关、三段任务的进度与日志。
 *
 * 抽成 hook 是为了让页面组件只负责排版；这里不产生任何 JSX。
 */
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { bridge, primeSummary, reloadSummary, useProgress } from '../../bridge/index.js';
import type { BatchRow, LogLine, OpKind, RunningOp } from '../../bridge/index.js';
import { notify, notifyResult, useBusy } from '../../components/index.js';

export type RangePreset = '7d' | '30d' | 'month' | 'custom';

export const RANGE_OPTIONS = [
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '本月', value: 'month' },
  { label: '自定义', value: 'custom' },
];

export function rangeFor(preset: RangePreset, current: [Dayjs, Dayjs]): [Dayjs, Dayjs] {
  const today = dayjs();
  if (preset === '7d') return [today.subtract(6, 'day'), today];
  if (preset === '30d') return [today.subtract(29, 'day'), today];
  if (preset === 'month') return [today.startOf('month'), today];
  return current;
}

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

function timeNow(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function useRunController(): RunController {
  const { busy, running } = useBusy();
  const fetchProgress = useProgress('fetch');
  const fileProgress = useProgress('files');
  const ocrProgress = useProgress('ocr');

  const [preset, setPreset] = useState<RangePreset>('30d');
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => rangeFor('30d', [dayjs(), dayjs()]));
  const [matchSubject, setMatchSubject] = useState(true);
  const [matchBody, setMatchBody] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [batch, setBatch] = useState<BatchRow[]>([]);
  const [notes, setNotes] = useState<LogLine[]>([]);

  function note(text: string, kind: LogLine['kind'] = 'info'): void {
    setNotes((prev) => [...prev, { id: prev.length + 1, time: timeNow(), text, kind }]);
  }

  /** 三路进度事件加本地提示，按时间戳合并成一条日志流。 */
  const logLines = useMemo(() => {
    const merged = [...notes, ...fetchProgress.lines, ...fileProgress.lines, ...ocrProgress.lines];
    return merged.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }, [notes, fetchProgress.lines, fileProgress.lines, ocrProgress.lines]);

  // 任务结束后 running 变回 null，但进度条与说明要停在最后跑过的那一步上。
  const [lastKind, setLastKind] = useState<OpKind>('fetch');
  useEffect(() => {
    if (running) setLastKind(running.kind);
  }, [running]);

  const shownKind = running?.kind ?? lastKind;
  const active = shownKind === 'ocr' ? ocrProgress : shownKind === 'pipeline' ? fileProgress : fetchProgress;
  const phase = PHASE_TEXT[active.phase] ?? '';

  /**
   * 走完一次运行。每条退出路径（含失败与试运行）都由 `start()` 兜一次
   * `reloadSummary()`：终态里带回的 summary 是截断过的，留着它会让发票库少行。
   */
  async function runOnce(): Promise<void> {
    note(dryRun ? '开始试运行' : '开始处理');
    const fetched = await bridge.startFetch({
      from: range[0].format('YYYY-MM-DD'),
      to: range[1].format('YYYY-MM-DD'),
      matchSubject,
      matchBody,
      dryRun,
    });
    setBatch(fetched.batch?.rows ?? []);
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
    if (ocr.code === 'ocr_no_work') note('没有待识别的文件');
    notifyResult(ocr.ok ? files : ocr, { success: '处理完成', failure: '识别未完成' });
  }

  async function start(): Promise<void> {
    if (!matchSubject && !matchBody) {
      notify.warning('至少选择一个匹配范围', '主题和正文需要勾选其中一项。');
      return;
    }
    try {
      await runOnce();
    } finally {
      await reloadSummary();
    }
  }

  async function stop(): Promise<void> {
    const result = await bridge.stopOcr();
    notifyResult(result, { success: '正在停止', failure: '停止失败' });
  }

  return {
    preset,
    setPreset,
    range,
    setRange,
    matchSubject,
    setMatchSubject,
    matchBody,
    setMatchBody,
    dryRun,
    setDryRun,
    busy,
    running,
    batch,
    logLines,
    percent: active.percent,
    statusText: busy ? `${phase || '处理中'}…` : active.latest?.message || '尚未运行',
    start,
    stop,
  };
}
