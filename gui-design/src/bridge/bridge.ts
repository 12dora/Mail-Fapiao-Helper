/**
 * 渲染层唯一的 IPC 出口。
 *
 * 两条硬规则：
 * 1. 组件不允许直接碰 `window.mfhBridge`，一律走这里的 `bridge`。
 * 2. preload 的 `on*` 每个通道只保留一个监听器（`removeAllListeners` 在前），
 *    所以订阅必须集中：本模块在启动时各注册一次，再向订阅者扇出。
 *    组件用 `subscribe(name, cb)` 拿到取消函数即可。
 */
import { createFakeBridge } from './fakeBridge.js';
import type {
  AppInfo,
  AppSummary,
  ArchiveJournalStatus,
  BaseResult,
  BridgeEventName,
  BridgeEvents,
  ConfigDraft,
  ConfigPayload,
  DedupePayload,
  DedupeResult,
  DeveloperResetResult,
  InvoiceDetailResult,
  ListMailboxesResult,
  MailDetailResult,
  MfhBridge,
  OpenMailPayload,
  OpenMailResult,
  OpenPathPayload,
  OpenResult,
  OpState,
  OrganizePayload,
  OrganizeResult,
  PendingIgnoreResult,
  PendingManualArchiveResult,
  RunOcrPayload,
  RunPipelinePayload,
  SaveConfigResult,
  StartFetchPayload,
  SummaryQuery,
  TerminalResult,
  TestConnectionResult,
} from './types.js';

/** 主进程还没实现该通道时的统一返回，调用方按普通失败处理即可。 */
const UNSUPPORTED: BaseResult = {
  ok: false,
  code: 'ipc_unavailable',
  message: '当前版本不支持该操作。',
  detail: '升级到包含该功能的版本后重试。',
};

function useFake(): boolean {
  if (typeof window === 'undefined') return true;
  if (window.location.search.includes('fake=1')) return true;
  return !window.mfhBridge;
}

const fakeMode = useFake();
const raw: MfhBridge = fakeMode ? createFakeBridge() : (window.mfhBridge as MfhBridge);

/** 当前跑在内存假数据上（浏览器预览、截图脚本、`?fake=1`）。 */
export function isFakeBridge(): boolean {
  return fakeMode;
}

// ---------------------------------------------------------------------------
// 订阅中心
// ---------------------------------------------------------------------------

type Listener<K extends BridgeEventName> = (data: BridgeEvents[K]) => void;

const listeners: { [K in BridgeEventName]: Set<Listener<K>> } = {
  fetchProgress: new Set(),
  operationProgress: new Set(),
  fileProgress: new Set(),
  opState: new Set(),
};

/** 每个通道最后一次事件，新订阅者立刻拿到当前状态，不用等下一次推送。 */
const lastEvent: Partial<{ [K in BridgeEventName]: BridgeEvents[K] }> = {};

function emit<K extends BridgeEventName>(name: K, data: BridgeEvents[K]): void {
  lastEvent[name] = data;
  for (const cb of listeners[name]) {
    try {
      cb(data);
    } catch (err) {
      console.error(`[bridge] ${name} 订阅者抛错`, err);
    }
  }
}

let hubStarted = false;

/** 在 main.tsx 里调用一次；重复调用无副作用。 */
export function startEventHub(): void {
  if (hubStarted) return;
  hubStarted = true;
  raw.onFetchProgress((data) => emit('fetchProgress', data));
  raw.onOperationProgress((data) => emit('operationProgress', data));
  raw.onFileProgress((data) => emit('fileProgress', data));
  raw.onOpState((data) => emit('opState', data));
}

/** 订阅一个事件通道，返回取消函数。 */
export function subscribe<K extends BridgeEventName>(name: K, cb: Listener<K>): () => void {
  startEventHub();
  listeners[name].add(cb);
  return () => {
    listeners[name].delete(cb);
  };
}

/** 读取某通道最近一次事件（订阅前的补齐用）。 */
export function lastEventOf<K extends BridgeEventName>(name: K): BridgeEvents[K] | undefined {
  return lastEvent[name];
}

// ---------------------------------------------------------------------------
// 方法门面
// ---------------------------------------------------------------------------

function optional<T>(fn: unknown, payload: unknown): Promise<T> {
  if (typeof fn !== 'function') return Promise.resolve(UNSUPPORTED as T);
  return (fn as (p: unknown) => Promise<T>)(payload);
}

export const bridge = {
  getSummary: (payload?: SummaryQuery): Promise<AppSummary> => raw.getSummary(payload),
  getConfig: (): Promise<ConfigPayload> => raw.getConfig(),
  saveConfig: (payload: ConfigDraft): Promise<SaveConfigResult> => raw.saveConfig(payload),

  startFetch: (payload: StartFetchPayload): Promise<TerminalResult> => raw.startFetch(payload),
  runPipeline: (payload: RunPipelinePayload = {}): Promise<TerminalResult> => raw.runPipeline(payload),
  runOcr: (payload: RunOcrPayload = {}): Promise<TerminalResult> => raw.runOcr(payload),
  stopOcr: (): Promise<BaseResult> => raw.stopOcr(),
  organize: (payload: OrganizePayload = {}): Promise<OrganizeResult> => raw.organize(payload),

  openPath: (payload: OpenPathPayload): Promise<OpenResult> => raw.openPath(payload),
  /** 打开归档文件本身（不是所在目录）。 */
  openFile: (handle: string): Promise<OpenResult> => raw.openPath({ handle, reveal: false }),
  /** 在文件管理器中定位归档文件。 */
  revealFile: (handle: string): Promise<OpenResult> => raw.openPath({ handle, reveal: true }),
  copyText: (text: string): Promise<BaseResult> => raw.copyText({ text }),

  getOpState: (): Promise<OpState> => raw.getOpState(),
  getAppInfo: (): Promise<AppInfo> => raw.getAppInfo(),

  testMailConnection: (payload: ConfigDraft): Promise<TestConnectionResult> => raw.testMailConnection(payload),
  listMailboxes: (payload: ConfigDraft): Promise<ListMailboxesResult> => raw.listMailboxes(payload),

  pendingIgnore: (hash: string): Promise<PendingIgnoreResult> => raw.pendingIgnore({ hash }),
  pendingManualArchive: (hash: string): Promise<PendingManualArchiveResult> => raw.pendingManualArchive({ hash }),

  developerReset: (): Promise<DeveloperResetResult> => raw.developerReset(),
  archiveJournalStatus: (): Promise<ArchiveJournalStatus> => raw.archiveJournalStatus(),
  archiveJournalQuarantine: (): Promise<BaseResult> => raw.archiveJournalQuarantine({ confirm: true }),

  // ipc-contract.md 新增通道：主进程未实现时返回 UNSUPPORTED，界面按失败提示处理。
  mailDetail: (hash: string): Promise<MailDetailResult> => optional<MailDetailResult>(raw.mailDetail, { hash }),
  /** 打开原始邮件；旧版本回退到 pendingRefreshLink（同一套主进程逻辑）。 */
  openMail: (payload: OpenMailPayload): Promise<OpenMailResult> => {
    if (typeof raw.openMail === 'function') return raw.openMail(payload);
    return raw.pendingRefreshLink({ hash: payload.hash });
  },
  invoiceDetail: (filename: string): Promise<InvoiceDetailResult> =>
    optional<InvoiceDetailResult>(raw.invoiceDetail, { filename }),
  dedupe: (payload: DedupePayload): Promise<DedupeResult> => optional<DedupeResult>(raw.dedupe, payload),

  /** 新通道是否可用，用来决定按钮显不显示。 */
  supports: (name: 'mailDetail' | 'openMail' | 'invoiceDetail' | 'dedupe'): boolean =>
    typeof raw[name] === 'function',
};

export type Bridge = typeof bridge;
