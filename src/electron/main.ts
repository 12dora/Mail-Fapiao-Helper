import { recoverArchiveTransactions } from '../download/archiveJournal.js';
import { readCsvRows } from '../util/csv.js';
import { createArchiveRecovery } from './archiveRecovery.js';
import { createCliRunner } from './cliRunner.js';
import { loadGuiConfig } from './summary.js';
import {
  looksLikeRedactedPathDisplay,
  readConfigForPaths,
  redactConfig,
  saveConfig,
} from './configService.js';
import { electron } from './electronApi.js';
import { registerOperationHandlers } from './ipc/operationHandlers.js';
import { registerMailHandlers } from './ipc/mailHandlers.js';
import { registerResetHandlers } from './ipc/resetHandlers.js';
import { installLifecycle } from './lifecycle.js';
import { createOpenPolicy } from './openPolicy.js';
import { createOperationSupport } from './operationSupport.js';
import { createOcrRerun } from './ocrRerun.js';
import { asObject } from './payload.js';
import { createPathPolicy } from './pathPolicy.js';
import { createPendingStore } from './pendingStore.js';
import { killProcessTree, terminateChildren } from './procTree.js';
import {
  sendFileProgress,
  sendOperationProgress,
  sendProgress,
  sendToRenderer,
} from './rendererEvents.js';
import { createResetService } from './resetService.js';
import {
  bundledConfigPath,
  configPath,
  coordinator,
  dataDir,
  e2eNoGuiMode,
  ensureUserDataConfig,
  getDevBackend,
  loadDevFakeBackend,
  processRegistries,
  rootDir,
  statePath,
  uiPath,
} from './runtime.js';
import {
  ocrRunMessage,
  pipelineRunMessage,
  recordHistory,
  reportFor,
  tryAppSummary,
} from './runSupport.js';
import { registerManagedRoots } from './sanitize.js';
import {
  ensureBaseDirectories,
  invoicesDirPath,
  ledgerCsvPath,
  ocrPendingCsvPath,
  ocrResultsCsvPath,
  pendingDirPath,
  resolvedPath,
  samplesDirPath,
} from './storagePaths.js';
import { createSummaryFacade, type SummaryPageOptions } from './summaryFacade.js';
import {
  cleanupAllTempDirs,
  cleanupStaleTempDirs,
  removeTempDir,
  writeOcrRunConfig,
} from './tempFiles.js';
import { createWindowSecurity, sanitizeOpState } from './windowSecurity.js';

export type { SaveConfigOutcome } from './configService.js';

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = electron;

registerManagedRoots({ dataDir, appRoot: rootDir });

const pathPolicy = createPathPolicy({
  dataDir,
  asObject,
  invoicesDirPath,
  pendingDirPath,
  samplesDirPath,
  resolvedPath,
  ledgerCsvPath,
});

const openPolicy = createOpenPolicy({ e2eNoGuiMode, shell });
const ocrRerun = createOcrRerun({ dataDir, ocrResultsCsvPath, ocrPendingCsvPath });

const summaryFacade = createSummaryFacade({
  configPath,
  dataDir,
  bundledConfigPath,
  asObject,
  resolveCanonicalPath: pathPolicy.resolveCanonicalPath,
  realDataDir: pathPolicy.realDataDir,
  isPathSegmentInside: pathPolicy.isPathSegmentInside,
  isInsideOpenPathAllowedRoots: pathPolicy.isInsideOpenPathAllowedRoots,
});

const pendingStore = createPendingStore({
  dataDir,
  pendingDirPath,
  isCanonicallyInside: pathPolicy.isCanonicallyInside,
  resolveCanonicalPath: pathPolicy.resolveCanonicalPath,
});

const operationSupport = createOperationSupport({
  coordinator,
  appSummary: summaryFacade.appSummary,
  readConfigForPaths,
  asObject,
  samplesDirPath,
  isCanonicallyInside: pathPolicy.isCanonicallyInside,
  persistedMailHash: pendingStore.persistedMailHash,
  configPath,
  statePath,
});

const archiveRecovery = createArchiveRecovery({
  invoicesDirPath,
  e2eNoGuiMode,
  dialog,
});

const windowSecurity = createWindowSecurity({
  BrowserWindow,
  ipcMain,
  rootDir,
  e2eNoGuiMode,
  uiPath,
  sendToRenderer,
  coordinatorState: () => coordinator.state(),
});

const { runCli } = createCliRunner({
  rootDir,
  dataDir,
  coordinator,
  getDevBackend,
  readConfigForPaths,
  activeChildren: processRegistries.activeChildren,
  ocrProcesses: processRegistries.ocrProcesses,
  ocrStopRequested: processRegistries.ocrStopRequested,
  sendProgress,
  sendOperationProgress,
  sendFileProgress,
});

const appSummary = (options?: unknown) => summaryFacade.appSummary(options as SummaryPageOptions | undefined);
const saveConfigWithPolicy = (payload: unknown, opts: { repairCorrupt?: boolean } = {}) => (
  saveConfig(payload, opts, pathPolicy.validateSavePathFields)
);
const safeSummary = () => tryAppSummary(summaryFacade.appSummary);

const operationHandlers = registerOperationHandlers({
  app,
  clipboard,
  handleTrusted: windowSecurity.handleTrusted,
  coordinator,
  processRegistries,
  getMainWindow: windowSecurity.getMainWindow,
  getDevBackend,
  configPath,
  statePath,
  bundledConfigPath,
  dataDir,
  loadGuiConfig,
  redactConfig,
  saveConfig: saveConfigWithPolicy,
  looksLikeRedactedPathDisplay,
  appSummary,
  asSummaryOptions: summaryFacade.asSummaryOptions,
  resolveExternalFileHandle: summaryFacade.resolveExternalFileHandle,
  sanitizeOpState,
  acquireOperation: operationSupport.acquireOperation,
  normalizedFilterFrom: operationSupport.normalizedFilterFrom,
  batchFromHashes: operationSupport.batchFromHashes,
  fetchArgs: operationSupport.fetchArgs,
  runCli,
  reportFor,
  recordHistory,
  tryAppSummary,
  ocrRunMessage,
  pipelineRunMessage,
  ocrPendingCsvPath,
  readCsvRows,
  ensureArchiveRecoveryReady: archiveRecovery.ensureArchiveRecoveryReady,
  prepareOcrRerun: ocrRerun.prepareOcrRerun,
  writeOcrRunConfig,
  removeTempDir,
  sendOperationProgress,
  killProcessTree,
  resolvedPath,
  pendingDirPath,
  invoicesDirPath,
  samplesDirPath,
  ledgerCsvPath,
  realDataDir: pathPolicy.realDataDir,
  resolveCanonicalPath: pathPolicy.resolveCanonicalPath,
  isPathSegmentInside: pathPolicy.isPathSegmentInside,
  isInsideOpenPathAllowedRoots: pathPolicy.isInsideOpenPathAllowedRoots,
  openPathAllowedRoots: pathPolicy.openPathAllowedRoots,
  resolveSymbolicLocation: pathPolicy.resolveSymbolicLocation,
  openOrRevealByPolicy: openPolicy.openOrRevealByPolicy,
});

registerMailHandlers({
  handleTrusted: windowSecurity.handleTrusted,
  coordinator,
  saveConfig,
  validateSavePathFields: pathPolicy.validateSavePathFields,
  readConfigForPaths,
  getDevBackend,
  acquireOperation: (kind) => operationSupport.acquireOperation(kind) as (
    | { ok: true; lease: { release(): void } }
    | { ok: false; response: { ok: false; code: string; message: string; [key: string]: unknown } }
  ),
  rewritePendingCsv: pendingStore.rewritePendingCsv,
  pendingRowMatchesHash: pendingStore.pendingRowMatchesHash,
  tryAppSummary: safeSummary,
  findPendingRow: pendingStore.findPendingRow,
  pendingEmlPathForHash: pendingStore.pendingEmlPathForHash,
  openOrRevealByPolicy: openPolicy.openOrRevealByPolicy,
  showItemInFolderForUser: openPolicy.showItemInFolderForUser,
  resolveOpenTarget: operationHandlers.resolveOpenTarget,
  realDataDir: pathPolicy.realDataDir,
  samplesDirPath,
  getMainWindow: windowSecurity.getMainWindow,
  assertTrustedSender: windowSecurity.assertTrustedSender,
  ensureArchiveRecoveryReady: archiveRecovery.ensureArchiveRecoveryReady,
  archiveRecoveryBlockedError: archiveRecovery.archiveRecoveryBlockedError,
  recordArchiveRecoveryFailure: archiveRecovery.recordArchiveRecoveryFailure,
  invoicesDirPath,
  ledgerCsvPath,
  ocrPendingCsvPath,
  appSummary: summaryFacade.appSummary,
});

const resetService = createResetService({
  app,
  dialog,
  dataDir,
  configPath,
  statePath,
  realDataDir: pathPolicy.realDataDir,
  resolveCanonicalPath: pathPolicy.resolveCanonicalPath,
  isCanonicallyInside: pathPolicy.isCanonicallyInside,
  assertSafeToDeleteInsideDataDir: pathPolicy.assertSafeToDeleteInsideDataDir,
  readConfigForPaths,
  asObject,
  e2eNoGuiMode,
  assertTrustedSender: windowSecurity.assertTrustedSender,
  getMainWindow: windowSecurity.getMainWindow,
  currentOperation: () => coordinator.state().running,
  acquireOperation: (kind) => operationSupport.acquireOperation(kind) as ReturnType<typeof operationSupport.acquireOperation> & (
    | { ok: true }
    | { ok: false; response: Record<string, unknown> }
  ),
  ensureBaseDirectories,
  appSummary: summaryFacade.appSummary,
});

registerResetHandlers({
  handleTrusted: windowSecurity.handleTrusted,
  performDeveloperReset: resetService.performDeveloperReset,
  archiveJournalStatus: archiveRecovery.archiveJournalStatus,
  quarantineArchiveJournalsWithConfirm: archiveRecovery.quarantineArchiveJournalsWithConfirm,
  asObject,
  acquireOperation: operationSupport.acquireOperation,
});

// ELEC-05：打包应用始终申请单实例锁。仅未打包 + 显式 E2E 隔离数据目录时才跳过。
const isolatedTestInstance = !app.isPackaged
  && process.env.MFH_E2E_NO_GUI === '1'
  && Boolean(process.env.MFH_DATA_DIR);
const hasSingleInstanceLock = isolatedTestInstance ? true : app.requestSingleInstanceLock();
if (e2eNoGuiMode() && process.platform === 'darwin') {
  try {
    app.dock?.hide();
  } catch {
    // Test-only best effort: hidden windows are the primary no-GUI contract.
  }
}
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const mainWindow = windowSecurity.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      windowSecurity.createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

coordinator.setBroadcast((payload) => {
  sendToRenderer('op-state', sanitizeOpState(payload) as unknown as Record<string, unknown>);
});

installLifecycle({
  app,
  BrowserWindow,
  dialog,
  hasSingleInstanceLock,
  dataDir,
  e2eNoGuiMode,
  ensureUserDataConfig,
  cleanupStaleTempDirs,
  cleanupAllTempDirs,
  invoicesDirPath,
  recoverArchiveTransactions,
  recoverOcrRerunJournals: ocrRerun.recoverOcrRerunJournals,
  loadDevFakeBackend,
  createWindow: windowSecurity.createWindow,
  coordinatorDispose: () => coordinator.dispose(),
  activeChildren: {
    size: () => processRegistries.activeChildren.size,
    clear: () => processRegistries.activeChildren.clear(),
    terminate: () => terminateChildren(processRegistries.activeChildren),
  },
});
