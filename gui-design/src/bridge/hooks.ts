/**
 * 桥接数据的 React 入口。
 *
 * `useSummary` / `useConfig` 背后是模块级单例 store：同一份数据只请求一次，
 * 任何页面调用 `reload()` 都会通知全部订阅者，避免各页各自轮询。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { bridge, lastEventOf, subscribe } from './bridge.js';
import type {
  AppInfo,
  AppSummary,
  ConfigPayload,
  FetchProgress,
  FileProgress,
  OperationProgress,
  OpState,
  ProgressKind,
} from './types.js';

// ---------------------------------------------------------------------------
// 通用异步 store
// ---------------------------------------------------------------------------

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string;
  /**
   * 当前这份数据不是自己按完整查询取回来的，而是别人塞进来的（长任务终态里
   * 捎带的那一份），可能已经被后端的默认行数截断。只能拿来点计数，
   * 搜索、导出这类要「全部行」的用途必须等一次 `reload()`。
   */
  partial: boolean;
}

interface Store<T> {
  get(): AsyncState<T>;
  subscribe(cb: () => void): () => void;
  load(force?: boolean): Promise<void>;
  set(data: T, partial?: boolean): void;
}

function createStore<T>(fetcher: () => Promise<T>): Store<T> {
  let state: AsyncState<T> = { data: null, loading: false, error: '', partial: false };
  const subscribers = new Set<() => void>();
  let inflight: Promise<void> | null = null;

  function set(next: AsyncState<T>): void {
    state = next;
    for (const cb of subscribers) cb();
  }

  function load(force = false): Promise<void> {
    if (inflight && !force) return inflight;
    set({ ...state, loading: true, error: '' });
    const run = fetcher()
      // 自己取回来的一定是完整的那份，顺手把 partial 摘掉。
      .then((data) => set({ data, loading: false, error: '', partial: false }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        set({ data: state.data, loading: false, error: message, partial: state.partial });
      })
      .finally(() => {
        inflight = null;
      });
    inflight = run;
    return run;
  }

  return {
    get: () => state,
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    load,
    set(data, partial = false) {
      set({ data, loading: false, error: '', partial });
    },
  };
}

/** 渲染层一次性把全部行拉下来，分页在 antd Table 里做。 */
const SUMMARY_QUERY = { inboxLimit: 100000, libraryLimit: 100000 } as const;

const summaryStore = createStore<AppSummary>(() => bridge.getSummary(SUMMARY_QUERY));
const configStore = createStore<ConfigPayload>(() => bridge.getConfig());
const appInfoStore = createStore<AppInfo>(() => bridge.getAppInfo());

function useStore<T>(store: Store<T>): AsyncState<T> & { reload: () => Promise<void> } {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    // 手里只有截断过的那一份时也要补一次完整查询：操作结束后的那次 reload
    // 可能失败过，否则这一页会一直按不完整的数据搜索和导出。
    if (state.loading) return;
    if (state.partial) void store.load(true);
    else if (!state.data && !state.error) void store.load();
    // 只在挂载时触发首次加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reload = useCallback(() => store.load(true), [store]);
  return { ...state, reload };
}

/** 全应用共享的汇总数据。任何写操作完成后调用 `reload()`。 */
export function useSummary(): AsyncState<AppSummary> & { reload: () => Promise<void> } {
  return useStore(summaryStore);
}

/** 全应用共享的配置。 */
export function useConfig(): AsyncState<ConfigPayload> & { reload: () => Promise<void> } {
  return useStore(configStore);
}

/** 版本与运行环境，侧栏底部与设置页用。 */
export function useAppInfo(): AsyncState<AppInfo> & { reload: () => Promise<void> } {
  return useStore(appInfoStore);
}

/** 让非组件代码（例如操作回调）也能刷新共享数据。 */
export function reloadSummary(): Promise<void> {
  return summaryStore.load(true);
}

export function reloadConfig(): Promise<void> {
  return configStore.load(true);
}

/**
 * 主进程在长任务终态里直接带回的那份 summary，只用来让计数立刻跟上。
 *
 * 它走的是后端的默认行数（500 行），不是 `SUMMARY_QUERY` 的十万行，所以标成
 * partial：调用方必须紧跟一次 `reloadSummary()`，否则发票库的搜索、导出和按行
 * 算出来的计数都会少记录。
 */
export function primeSummary(next: AppSummary | undefined): void {
  if (!next) return;
  summaryStore.set(next, true);
}

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------

/** 当前互斥任务；`running` 非空时所有会写盘的按钮都应禁用。 */
export function useOpState(): OpState {
  const [state, setState] = useState<OpState>(() => lastEventOf('opState') ?? { running: null });
  useEffect(() => {
    let alive = true;
    void bridge
      .getOpState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => undefined);
    const off = subscribe('opState', (next) => setState(next));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------

export type ProgressChannel = 'fetch' | 'ocr' | 'files';

export interface LogLine {
  id: number;
  time: string;
  text: string;
  kind: ProgressKind;
}

export interface ProgressState {
  /** 最近一次进度事件；任务还没跑过时为 null。 */
  latest: FetchProgress | OperationProgress | FileProgress | null;
  percent: number;
  phase: string;
  /** 已经开始且还没收到 done。 */
  active: boolean;
  lines: LogLine[];
  append(text: string, kind?: ProgressKind): void;
  clear(): void;
}

const CHANNEL_MAP = {
  fetch: 'fetchProgress',
  ocr: 'operationProgress',
  files: 'fileProgress',
} as const;

function stamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

interface ChannelState {
  latest: ProgressState['latest'];
  lines: LogLine[];
  active: boolean;
}

const EMPTY_CHANNEL: ChannelState = { latest: null, lines: [], active: false };

/**
 * 识别收尾时把失败原因逐条摊到日志里。
 *
 * 单条失败只发 `ocr_item_failed`（「文件识别失败，请查看技术详情」），几百份一起
 * 失败时日志里就是同一句话刷屏，看不出到底是哪儿坏了。收尾事件带回的这几条才
 * 说得清原因，所以单独落成日志行。
 */
function failureNotes(data: FetchProgress | OperationProgress | FileProgress): string[] {
  if (!('operation' in data) || data.operation !== 'ocr' || !data.done) return [];
  return (data.failureReasons ?? []).map((item) => `主要失败原因：${item.reason}（${item.count} 个）`);
}

/** 一条进度通道的累积状态。 */
interface ChannelStore {
  get(): ChannelState;
  subscribe(cb: () => void): () => void;
  append(text: string, kind?: ProgressKind): void;
  clear(): void;
}

/**
 * 通道 store 在模块初始化时就挂到 hub 上，而不是等某个组件挂载。
 *
 * 页面组件会随路由卸载；订阅跟着组件走的话，用户切走的那段时间里的进度事件就
 * 永远丢了，回来看到的是一段没有开头的日志。订阅放在这里，切页只是换一个读者。
 */
function createChannelStore(channel: ProgressChannel): ChannelStore {
  let state = EMPTY_CHANNEL;
  const subscribers = new Set<() => void>();
  let seq = 0;

  function commit(next: ChannelState): void {
    state = next;
    for (const cb of subscribers) cb();
  }

  /** 日志有上限：一次长跑几万行也不会把内存吃满。 */
  function push(lines: LogLine[], text: string, kind: ProgressKind): LogLine[] {
    const next = [...lines, { id: ++seq, time: stamp(), text, kind }];
    return next.length > 500 ? next.slice(next.length - 500) : next;
  }

  function append(text: string, kind: ProgressKind = 'info'): void {
    if (!text) return;
    commit({ ...state, lines: push(state.lines, text, kind) });
  }

  subscribe(CHANNEL_MAP[channel], (data) => {
    let lines = data.message ? push(state.lines, data.message, data.kind ?? 'info') : state.lines;
    for (const note of failureNotes(data)) lines = push(lines, note, 'warn');
    commit({ latest: data, active: !data.done, lines });
  });

  return {
    get: () => state,
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    append,
    clear: () => commit({ ...state, lines: [] }),
  };
}

const channelStores: Record<ProgressChannel, ChannelStore> = {
  fetch: createChannelStore('fetch'),
  ocr: createChannelStore('ocr'),
  files: createChannelStore('files'),
};

/**
 * 读一路进度事件的累积状态。
 * 同一个通道可以被多个组件读——扇出在 bridge 里做，preload 只有一个监听器。
 */
export function useProgress(channel: ProgressChannel): ProgressState {
  const store = channelStores[channel];
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);

  const phase = state.latest ? ('step' in state.latest ? state.latest.step : state.latest.phase) : '';
  const percent = state.latest ? Math.max(0, Math.min(100, Math.round(state.latest.percent))) : 0;

  return {
    latest: state.latest,
    percent,
    phase,
    active: state.active,
    lines: state.lines,
    append: store.append,
    clear: store.clear,
  };
}
