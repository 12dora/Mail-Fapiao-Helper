const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mfhBridge', {
  getSummary: () => ipcRenderer.invoke('mfh:get-summary'),
  getConfig: () => ipcRenderer.invoke('mfh:get-config'),
  saveConfig: (payload) => ipcRenderer.invoke('mfh:save-config', payload),
  startFetch: (payload) => ipcRenderer.invoke('mfh:start-fetch', payload),
  runPipeline: (payload) => ipcRenderer.invoke('mfh:run-pipeline', payload),
  runOcr: (payload) => ipcRenderer.invoke('mfh:run-ocr', payload),
  organize: (payload) => ipcRenderer.invoke('mfh:organize', payload),
  openPath: (payload) => ipcRenderer.invoke('mfh:open-path', payload),
  copyText: (payload) => ipcRenderer.invoke('mfh:copy-text', payload),
  testConnection: () => ipcRenderer.invoke('mfh:test-connection'),
  developerReset: () => ipcRenderer.invoke('mfh:developer-reset'),
  onFetchProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.removeAllListeners('mfh:fetch-progress');
    ipcRenderer.on('mfh:fetch-progress', (_event, data) => callback(data));
  },
});
