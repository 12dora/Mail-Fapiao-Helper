/**
 * 桥接数据的 React 入口。
 *
 * `useSummary` / `useConfig` 背后是模块级单例 store：同一份数据只请求一次，
 * 任何页面调用 `reload()` 都会通知全部订阅者，避免各页各自轮询。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
}

interface Store<T> {
  get(): AsyncState<T>;
  subscribe(cb: () => void): () => void;
  load(force?: boolean): Promise<void>;
  set(data: T): void;
}

function createStore<T>(fetcher: () => Promise<T>): Store<T> {
  let state: AsyncState<T> = { data: null, loading: false, error: '' };
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
      .then((data) => set({ data, loading: false, error: '' }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        set({ data: state.data, loading: false, error: message });
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
    set(data) {
      set({ data, loading: false, error: '' });
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
    if (!state.data && !state.loading && !state.error) void store.load();
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

/** 主进程在长任务终态里直接带回新的 summary，省掉一次往返。 */
export function primeSummary(next: AppSummary | undefined): void {
  if (!next) return;
  summaryStore.set(next);
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

/**
 * 订阅一路进度事件，并把 message 累积成日志行。
 * 同一个通道可以被多个组件订阅——扇出在 bridge 里做，preload 只有一个监听器。
 */
export function useProgress(channel: ProgressChannel): ProgressState {
  const [latest, setLatest] = useState<ProgressState['latest']>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [active, setActive] = useState(false);
  const seq = useRef(0);

  const append = useCallback((text: string, kind: ProgressKind = 'info') => {
    if (!text) return;
    setLines((prev) => {
      const id = ++seq.current;
      const next = [...prev, { id, time: stamp(), text, kind }];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  const clear = useCallback(() => setLines([]), []);

  useEffect(() => {
    const off = subscribe(CHANNEL_MAP[channel], (data) => {
      setLatest(data);
      setActive(!data.done);
      if (data.message) append(data.message, data.kind);
    });
    return off;
  }, [channel, append]);

  const phase = latest ? ('step' in latest ? latest.step : latest.phase) : '';
  const percent = latest ? Math.max(0, Math.min(100, Math.round(latest.percent))) : 0;

  return { latest, percent, phase, active, lines, append, clear };
}
