/**
 * 「开始处理」这一次运行的状态，放在模块级。
 *
 * 为什么不是组件状态：`start()` 是一串 await，用户完全可以在中途切到发票库看
 * 一眼再回来。页面组件一旦卸载，它的 setState 就落到了一个不存在的组件上，
 * 回来时看到的是空日志、空批次和归零的进度——运行其实还在跑。
 *
 * 所以这里只放「一次运行」自己的状态（时间范围、匹配开关、本次结果、本地提示）。
 * 三路进度事件的累积在 bridge/hooks.ts 的通道 store 里，同样是模块级。
 */
import dayjs, { type Dayjs } from 'dayjs';
import type { BatchRow, LogLine, OpKind, ProgressKind } from '../bridge/index.js';

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

export interface RunState {
  preset: RangePreset;
  range: [Dayjs, Dayjs];
  matchSubject: boolean;
  matchBody: boolean;
  dryRun: boolean;
  /** 本次运行抓到的邮件；试运行不回填。 */
  batch: BatchRow[];
  /** 界面自己写的日志行（「开始处理」这类），与进度事件合并后展示。 */
  notes: LogLine[];
  /** 任务结束后 running 变回 null，进度条要停在最后跑过的那一类任务上。 */
  lastKind: OpKind;
}

function initial(): RunState {
  return {
    preset: '30d',
    range: rangeFor('30d', [dayjs(), dayjs()]),
    matchSubject: true,
    matchBody: true,
    dryRun: false,
    batch: [],
    notes: [],
    lastKind: 'fetch',
  };
}

let state = initial();
const subscribers = new Set<() => void>();
let noteSeq = 0;

function commit(next: RunState): void {
  state = next;
  for (const cb of subscribers) cb();
}

export function getRunState(): RunState {
  return state;
}

export function subscribeRun(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function patchRun(next: Partial<RunState>): void {
  commit({ ...state, ...next });
}

function timeNow(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** 界面自己写的一行日志。上限与进度日志一致，长跑不会把内存吃满。 */
export function appendRunNote(text: string, kind: ProgressKind = 'info'): void {
  if (!text) return;
  const line: LogLine = { id: ++noteSeq, time: timeNow(), text, kind };
  const notes = [...state.notes, line];
  commit({ ...state, notes: notes.length > 500 ? notes.slice(notes.length - 500) : notes });
}
