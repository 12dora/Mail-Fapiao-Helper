const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mfhBridge', {
  getSummary: () => ipcRenderer.invoke('mfh:get-summary'),
  getConfig: () => ipcRenderer.invoke('mfh:get-config'),
  saveConfig: (payload) => ipcRenderer.invoke('mfh:save-config', payload),
  startFetch: (payload) => ipcRenderer.invoke('mfh:start-fetch', payload),
  runPipeline: (payload) => ipcRenderer.invoke('mfh:run-pipeline', payload),
  runOcr: (payload) => ipcRenderer.invoke('mfh:run-ocr', payload),
  stopOcr: () => ipcRenderer.invoke('mfh:stop-ocr'),
  clearOcrResults: () => ipcRenderer.invoke('mfh:clear-ocr-results'),
  organize: (payload) => ipcRenderer.invoke('mfh:organize', payload),
  openPath: (payload) => ipcRenderer.invoke('mfh:open-path', payload),
  copyText: (payload) => ipcRenderer.invoke('mfh:copy-text', payload),
  testConnection: (payload) => ipcRenderer.invoke('mfh:test-connection', payload),
  testMailConnection: (payload) => ipcRenderer.invoke('mfh:test-connection', payload),
  developerReset: () => ipcRenderer.invoke('mfh:developer-reset'),
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
});
