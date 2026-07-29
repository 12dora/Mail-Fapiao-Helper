const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mfhBridge', {
  // payload 可选：{ inboxLimit, inboxOffset, libraryLimit, libraryOffset }
  getSummary: (payload) => ipcRenderer.invoke('mfh:get-summary', payload),
  getConfig: () => ipcRenderer.invoke('mfh:get-config'),
  saveConfig: (payload) => ipcRenderer.invoke('mfh:save-config', payload),
  startFetch: (payload) => ipcRenderer.invoke('mfh:start-fetch', payload),
  runPipeline: (payload) => ipcRenderer.invoke('mfh:run-pipeline', payload),
  runOcr: (payload) => ipcRenderer.invoke('mfh:run-ocr', payload),
  stopOcr: () => ipcRenderer.invoke('mfh:stop-ocr'),
  organize: (payload) => ipcRenderer.invoke('mfh:organize', payload),
  openPath: (payload) => ipcRenderer.invoke('mfh:open-path', payload),
  copyText: (payload) => ipcRenderer.invoke('mfh:copy-text', payload),
  testMailConnection: (payload) => ipcRenderer.invoke('mfh:test-connection', payload),
  listMailboxes: (payload) => ipcRenderer.invoke('mfh:list-mailboxes', payload),
  pendingIgnore: (payload) => ipcRenderer.invoke('mfh:pending-ignore', payload),
  pendingRefreshLink: (payload) => ipcRenderer.invoke('mfh:pending-refresh-link', payload),
  pendingManualArchive: (payload) => ipcRenderer.invoke('mfh:pending-manual-archive', payload),
  developerReset: () => ipcRenderer.invoke('mfh:developer-reset'),
  // 当前是否有互斥操作在运行：{ running: null | { kind, jobId, startedAt } }
  getOpState: () => ipcRenderer.invoke('mfh:get-op-state'),
  // About 页的真实版本与发布通道：{ version, channel, packaged, platform, arch, electron }
  getAppInfo: () => ipcRenderer.invoke('mfh:get-app-info'),
  /**
   * 归档 journal 状态（只读）。设置页「归档恢复」面板与主进程注入 UI 会调用。
   * 返回：{ ok, code, status: 'clear'|'residual'|'unreadable', message, residualCount,
   *         parseableCount?, corruptCount?, blocked?, canQuarantine?, detail? }
   */
  archiveJournalStatus: () => ipcRenderer.invoke('mfh:archive-journal-status'),
  /**
   * 用户确认后隔离残留 journal（损坏 + 形态非法 + 可解析但无法自动清理）。
   * 必须传 { confirm: true }；隔离为 rename 到 `.journal-quarantine-<ts>`，不删除。
   * 设置页按钮在二次 confirm 后调用；写入门禁弹窗也会走同一主进程逻辑。
   */
  archiveJournalQuarantine: (payload) => ipcRenderer.invoke('mfh:archive-journal-quarantine', payload),
  onFetchProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.removeAllListeners('mfh:fetch-progress');
    ipcRenderer.on('mfh:fetch-progress', (_event, data) => callback(data));
  },
  onOperationProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.removeAllListeners('mfh:operation-progress');
    ipcRenderer.on('mfh:operation-progress', (_event, data) => callback(data));
  },
  onFileProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.removeAllListeners('mfh:file-progress');
    ipcRenderer.on('mfh:file-progress', (_event, data) => callback(data));
  },
  onOpState: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.removeAllListeners('op-state');
    ipcRenderer.on('op-state', (_event, data) => callback(data));
  },
});
