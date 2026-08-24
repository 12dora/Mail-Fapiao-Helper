import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ImapFlow } from 'imapflow';
import { ArchiveRecoveryError } from '../../download/archiveJournal.js';
import { parseMailHash } from '../cliProtocol.js';
import { electron } from '../electronApi.js';
import { runManualArchive } from '../manualArchive.js';
import { asObject, numberField, stringField } from '../payload.js';
import { sanitizeText, type UiError } from '../sanitize.js';

const { app, dialog } = electron;

type OpenTargetResult =
  | { ok: true; path: string }
  | { ok: false; code: string; message: string };

interface OpenPolicyResult {
  ok: boolean;
  error: string;
  code?: string;
  message?: string;
  revealed?: boolean;
}

interface OperationLease {
  release(): void;
}

interface BusyResponse {
  ok: false;
  code: string;
  message: string;
  [key: string]: unknown;
}

interface DevBackend {
  fakeConnectionResult(): { ok: true; message: string };
  fakeMailboxes(): string[];
}

interface SummaryPart {
  summary?: unknown;
  summaryUnavailable?: boolean;
  warning?: string;
}

export interface RegisterMailHandlersDeps {
  handleTrusted(
    channel: string,
    handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown,
  ): void;
  coordinator: {
    begin(kind: 'fetch', opts: { silent: true }):
      | { ok: true; lease: OperationLease }
      | { ok: false };
  };
  saveConfig(
    payload: unknown,
    opts: { repairCorrupt?: boolean },
    validateSavePathFields: (candidate: Record<string, unknown>) => { path: string; message: string }[],
  ): { ok: boolean };
  validateSavePathFields(candidate: Record<string, unknown>): { path: string; message: string }[];
  readConfigForPaths(): Record<string, unknown>;
  getDevBackend(): DevBackend | undefined;
  acquireOperation(kind: 'pipeline'):
    | { ok: true; lease: OperationLease }
    | { ok: false; response: BusyResponse };
  rewritePendingCsv(keep: (row: Record<string, string>) => boolean): { removed: number };
  pendingRowMatchesHash(row: Record<string, string>, hash: string): boolean;
  tryAppSummary(): SummaryPart;
  findPendingRow(hash: string): Record<string, string> | undefined;
  pendingEmlPathForHash(hash: string): string | undefined;
  openOrRevealByPolicy(
    target: string,
    opts: { allowDirectoryOpen: boolean; allowFileOpen: boolean },
  ): Promise<OpenPolicyResult>;
  showItemInFolderForUser(target: string): void;
  resolveOpenTarget(target: string): OpenTargetResult;
  realDataDir(): string | undefined;
  samplesDirPath(): string;
  getMainWindow(): BrowserWindow | undefined;
  assertTrustedSender(event: IpcMainInvokeEvent): boolean;
  ensureArchiveRecoveryReady(): UiError | undefined;
  archiveRecoveryBlockedError(extra?: string): UiError;
  recordArchiveRecoveryFailure(root: string, error: UiError): void;
  invoicesDirPath(): string;
  ledgerCsvPath(): string;
  ocrPendingCsvPath(): string;
  appSummary(): unknown;
}

/** 连接测试/文件夹列举共用的 IMAP 参数解析（保存失败时回退到用户刚输入的值）。 */
export function imapParamsFor(
  payload: unknown,
  saved: boolean,
  readConfigForPaths: () => Record<string, unknown>,
): {
  ok: boolean;
  message?: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
  mailbox: unknown;
} {
  const cfg = readConfigForPaths();
  const disk = asObject(cfg.imap);
  const typed = asObject(asObject(payload).imap);
  const pick = (key: string): unknown => (saved ? disk[key] : (typed[key] ?? disk[key]));
  const host = stringField(pick('host'));
  const port = numberField(pick('port'));
  const user = stringField(pick('user'));
  const pass = stringField(pick('pass')) || stringField(disk.pass);
  const tls = pick('tls') !== false;
  if (!host || !Number.isFinite(port) || port <= 0 || !user || !pass) {
    return { ok: false, message: '请先填写邮箱主机、端口、账号和授权码。', host, port, user, pass, tls, mailbox: pick('mailbox') };
  }
  return { ok: true, host, port, user, pass, tls, mailbox: pick('mailbox') };
}

async function openResolvedMail(
  targetPath: string,
  deps: RegisterMailHandlersDeps,
): Promise<Record<string, unknown>> {
  const result = await deps.openOrRevealByPolicy(targetPath, {
    allowDirectoryOpen: false,
    allowFileOpen: true,
  });
  if (result.ok && !result.revealed) {
    return {
      ok: true,
      opened: 'mail' as const,
      code: 'pending_mail_opened',
      message: '已打开原始邮件。请到开票平台重新下载发票，然后回到这里选择文件归档。',
    };
  }
  if (result.ok && result.revealed) {
    return {
      ok: true,
      opened: 'mail' as const,
      code: 'pending_mail_revealed',
      message: '已请求在文件管理器中显示原始邮件。请到开票平台重新下载发票，然后回到这里选择文件归档。若未看到窗口，请到「已保存邮件」中查找。',
    };
  }
  // 策略拒绝（可执行/bundle/替身/快捷方式等）：不得回退到无策略 open。
  const policyRefused = result.code === 'path_bundle_refused'
    || result.code === 'path_executable_refused'
    || result.code === 'path_not_openable'
    || result.code === 'path_alias_refused'
    || result.code === 'path_shortcut_refused'
    || result.code === 'path_missing';
  if (policyRefused) {
    return {
      ok: false,
      opened: 'none' as const,
      code: result.code,
      message: result.message ?? result.error ?? '出于安全考虑，无法打开该目标。',
      error: result.error,
    };
  }
  // open 失败：best-effort reveal（showItemInFolder 不会启动 .app）；目标已消失则如实失败。
  const stillThere = fs.existsSync(targetPath);
  if (stillThere) {
    try {
      deps.showItemInFolderForUser(targetPath);
    } catch {
      // best-effort
    }
  }
  return {
    ok: false,
    opened: stillThere ? 'reveal_attempted' as const : 'none' as const,
    code: stillThere ? 'pending_mail_open_failed_reveal_attempted' : 'pending_mail_open_failed',
    message: stillThere
      ? '无法用默认应用打开原始邮件；已请求在文件管理器中显示该文件。若未看到窗口，请到「已保存邮件」文件夹查找。'
      : '无法打开原始邮件，且文件似乎已不存在。',
    error: result.error ? sanitizeText(result.error, { maxLength: 200 }) : undefined,
  };
}

async function openPendingFallback(
  row: Record<string, string> | undefined,
  deps: RegisterMailHandlersDeps,
): Promise<Record<string, unknown>> {
  // 回退：打开邮件缓存目录。与 open-path 的 samples 符号位置一致：
  // resolveOpenTarget + openOrRevealByPolicy(allowDirectoryOpen)，bundle 会被拒绝。
  const fallback = deps.resolveOpenTarget(deps.samplesDirPath());
  if (!fallback.ok) {
    return {
      ok: false,
      opened: 'none' as const,
      code: row ? 'pending_mail_missing_local_copy' : 'pending_row_not_found',
      message: row
        ? '没有找到这封邮件的本地副本，且无法打开邮件缓存文件夹。'
        : '没有找到这封邮件。',
    };
  }
  const folderResult = await deps.openOrRevealByPolicy(fallback.path, {
    allowDirectoryOpen: true,
    allowFileOpen: false,
  });
  if (!folderResult.ok) {
    const refusedByPolicy = folderResult.code === 'path_bundle_refused'
      || folderResult.code === 'path_executable_refused'
      || folderResult.code === 'path_alias_refused'
      || folderResult.code === 'path_shortcut_refused'
      || folderResult.code === 'path_not_openable';
    if (refusedByPolicy) {
      return {
        ok: false,
        opened: 'none' as const,
        code: folderResult.code,
        message: folderResult.message ?? folderResult.error ?? '出于安全考虑，无法打开该位置。',
        ...(folderResult.error ? { error: sanitizeText(folderResult.error, { maxLength: 200 }) } : {}),
      };
    }
    // 含 path_missing / path_open_failed：不得报「已打开文件夹」。
    if (folderResult.code === 'path_missing') {
      return {
        ok: false,
        opened: 'none' as const,
        code: row ? 'pending_mail_missing_local_copy' : 'pending_row_not_found',
        message: row
          ? '没有找到这封邮件的本地副本，且邮件缓存文件夹不存在。请先在「开始处理」中获取邮件，或到「配置」检查邮件缓存路径。'
          : '没有找到这封邮件，且邮件缓存文件夹不存在。请先获取邮件或检查配置中的邮件缓存路径。',
        ...(folderResult.error ? { error: sanitizeText(folderResult.error, { maxLength: 200 }) } : {}),
      };
    }
    return {
      ok: false,
      opened: 'none' as const,
      code: row ? 'pending_mail_missing_local_copy' : 'pending_row_not_found',
      message: row
        ? '没有找到这封邮件的本地副本，且无法打开邮件缓存文件夹。'
        : '没有找到这封邮件，且无法打开邮件缓存文件夹。',
      ...(folderResult.error ? { error: sanitizeText(folderResult.error, { maxLength: 200 }) } : {}),
    };
  }
  // 若策略只能 reveal（例如配置把 samples 指到了非目录文件），如实区分。
  if (folderResult.revealed) {
    return {
      ok: true,
      opened: 'folder' as const,
      code: row ? 'pending_mail_folder_opened' : 'pending_row_not_found',
      message: row
        ? '没有找到原始邮件文件，已请求在文件管理器中显示邮件缓存位置，请手动查找后再到开票平台重新下载。若未看到窗口，请到「配置」核对邮件缓存路径。'
        : '没有找到这封邮件，已请求在文件管理器中显示邮件缓存位置。若未看到窗口，请到「配置」核对邮件缓存路径。',
    };
  }
  // COPY-05：打开的是文件夹，不是原始邮件本身。
  return {
    ok: true,
    opened: 'folder' as const,
    code: row ? 'pending_mail_folder_opened' : 'pending_row_not_found',
    message: row
      ? '没有找到原始邮件文件，已打开已保存邮件文件夹，请手动查找后再到开票平台重新下载。'
      : '没有找到这封邮件，已打开已保存邮件文件夹。',
  };
}

async function refreshPendingLink(
  payload: unknown,
  deps: RegisterMailHandlersDeps,
): Promise<Record<string, unknown>> {
  const raw = asObject(payload);
  const hash = parseMailHash(raw.hash);
  if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少邮件标识。' };
  const row = deps.findPendingRow(hash);
  const emlPath = deps.pendingEmlPathForHash(hash);

  /**
   * B2：所有桌面打开必须经 openOrRevealByPolicy（containment 之后的类型/目录/bundle 策略）。
   * 禁止在此直接 shell.openPath / 任何原始路径打开助手。
   * 路径由主进程从 hash + 归档根解析（非 renderer 配置 path），故允许 file open。
   */

  // ELEC-06：先 resolveOpenTarget containment，再 openOrRevealByPolicy。
  if (emlPath && fs.existsSync(emlPath)) {
    const opened = deps.resolveOpenTarget(emlPath);
    if (!opened.ok) {
      // 尝试 dataDir 相对路径
      const base = deps.realDataDir();
      const rel = base ? path.relative(base, emlPath) : emlPath;
      const openedRel = deps.resolveOpenTarget(rel);
      if (!openedRel.ok) {
        return { ok: false, code: openedRel.code, message: openedRel.message };
      }
      return openResolvedMail(openedRel.path, deps);
    }
    return openResolvedMail(opened.path, deps);
  }
  return openPendingFallback(row, deps);
}

export function registerMailHandlers(deps: RegisterMailHandlersDeps): void {
  deps.handleTrusted('mfh:test-connection', async (_event, payload: unknown) => {
    // ELEC-02：配置落盘必须占锁；忙时仍可用表单值测连，但不写盘。
    let saved = false;
    if (payload && typeof payload === 'object') {
      const begin = deps.coordinator.begin('fetch', { silent: true });
      if (begin.ok) {
        try {
          saved = deps.saveConfig(payload, {}, deps.validateSavePathFields).ok;
        } finally {
          begin.lease.release();
        }
      }
    }
    const devBackend = deps.getDevBackend();
    if (devBackend) return devBackend.fakeConnectionResult();
    const params = imapParamsFor(payload, saved, deps.readConfigForPaths);
    if (!params.ok) return { ok: false, code: 'imap_incomplete', message: params.message };
    try {
      const client = new ImapFlow({
        host: params.host,
        port: params.port,
        secure: params.tls,
        auth: { user: params.user, pass: params.pass },
        logger: false,
      });
      await client.connect();
      try {
        const configured = params.mailbox;
        const mailbox = Array.isArray(configured) && typeof configured[0] === 'string' && configured[0]
          ? configured[0]
          : 'INBOX';
        let fallbackMailbox = '';
        try {
          await client.mailboxOpen(mailbox);
        } catch {
          const boxes = await client.list();
          if (boxes.length > 0) {
            fallbackMailbox = boxes[0]!.path;
            await client.mailboxOpen(fallbackMailbox);
          }
        }
        if (fallbackMailbox) {
          return {
            ok: true,
            kind: 'warn',
            code: 'imap_mailbox_fallback',
            message: `邮箱连接正常，但找不到配置的文件夹「${mailbox}」，已临时打开「${fallbackMailbox}」。请在配置中重新选择目标文件夹。`,
          };
        }
        return { ok: true, code: 'imap_ok', message: '邮箱连接正常，可以获取邮件。' };
      } finally {
        // Always tear down the socket + keepalive timers, even on a secondary failure.
        await client.logout().catch(() => { try { client.close(); } catch { /* ignore */ } });
      }
    } catch (err) {
      return {
        ok: false,
        code: 'imap_connect_failed',
        message: '邮箱连接失败，请检查主机、端口、账号和授权码。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
      };
    }
  });

  deps.handleTrusted('mfh:list-mailboxes', async (_event, payload: unknown) => {
    let saved = false;
    if (payload && typeof payload === 'object') {
      const begin = deps.coordinator.begin('fetch', { silent: true });
      if (begin.ok) {
        try {
          saved = deps.saveConfig(payload, {}, deps.validateSavePathFields).ok;
        } finally {
          begin.lease.release();
        }
      }
    }
    const devBackend = deps.getDevBackend();
    if (devBackend) return { ok: true, mailboxes: devBackend.fakeMailboxes() };
    const params = imapParamsFor(payload, saved, deps.readConfigForPaths);
    if (!params.ok) return { ok: false, code: 'imap_incomplete', message: params.message, mailboxes: [] };
    try {
      const client = new ImapFlow({
        host: params.host,
        port: params.port,
        secure: params.tls,
        auth: { user: params.user, pass: params.pass },
        logger: false,
      });
      await client.connect();
      try {
        const boxes = await client.list();
        return { ok: true, mailboxes: boxes.map((b) => b.path).filter(Boolean) };
      } finally {
        await client.logout().catch(() => { try { client.close(); } catch { /* ignore */ } });
      }
    } catch (err) {
      return {
        ok: false,
        code: 'imap_list_failed',
        message: '读取邮箱文件夹失败，请检查邮箱配置。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
        mailboxes: [],
      };
    }
  });

  deps.handleTrusted('mfh:pending-ignore', (_event, payload: unknown) => {
    const raw = asObject(payload);
    const hash = parseMailHash(raw.hash);
    if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少待忽略邮件的标识。' };
    // ELEC-02：pending.csv 重写与 pipeline 互斥，必须占锁。
    const gate = deps.acquireOperation('pipeline');
    if (!gate.ok) return gate.response;
    try {
      const result = deps.rewritePendingCsv((row) => !deps.pendingRowMatchesHash(row, hash));
      if (result.removed === 0) {
        const summaryPart = deps.tryAppSummary();
        return {
          ok: false,
          code: 'pending_row_not_found',
          message: '没有找到对应的待确认邮件，可能已经处理过。',
          ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
          ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true, warning: summaryPart.warning } : {}),
        };
      }
      // 行已原子移除：摘要 enrich 失败不得把已成功的忽略报成失败（ELEC-08）。
      const summaryPart = deps.tryAppSummary();
      return {
        ok: true,
        code: 'pending_ignored',
        message: '已从待确认队列中移除该邮件。',
        removed: result.removed,
        ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
        ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
        ...(summaryPart.warning ? { warning: summaryPart.warning } : {}),
      };
    } finally {
      gate.lease.release();
    }
  });

  deps.handleTrusted('mfh:pending-refresh-link', async (_event, payload: unknown) => (
    refreshPendingLink(payload, deps)
  ));

  deps.handleTrusted('mfh:pending-manual-archive', async (event, payload: unknown) => {
    const raw = asObject(payload);
    const hash = parseMailHash(raw.hash);
    if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少邮件标识。', canceled: false };

    const testSources = !app.isPackaged && process.env.MFH_TEST_MANUAL_ARCHIVE_SOURCES
      ? process.env.MFH_TEST_MANUAL_ARCHIVE_SOURCES.split(path.delimiter).filter(Boolean)
      : undefined;
    const dialogOpts = {
      title: '选择要归档的发票文件',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [
        // 不提供 zip：压缩包无法直接归档也无法识别，旧实现会把任意 PK 容器当成 OFD
        // 塞进队列。用户仍可用「全部文件」选到压缩包，此时 runManualArchive 会明确拒绝。
        { name: '发票文件', extensions: ['pdf', 'ofd', 'png', 'jpg', 'jpeg'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    };
    const mainWindow = deps.getMainWindow();
    const dialogResult = testSources
      ? { canceled: false, filePaths: testSources }
      : mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
    // ELEC-01：await dialog 后重新校验 sender。
    if (!deps.assertTrustedSender(event)) {
      return { ok: false, code: 'untrusted_sender', message: '无权执行归档。', canceled: false };
    }
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return { ok: false, canceled: true, code: 'manual_archive_canceled', message: '已取消归档。' };
    }

    // 手动导入与自动归档写同一批文件，必须走同一把操作锁。
    const gate = deps.acquireOperation('pipeline');
    if (!gate.ok) return { ...gate.response, canceled: false };

    try {
      const recoveryError = deps.ensureArchiveRecoveryReady();
      if (recoveryError) {
        return { ok: false, canceled: false, ...recoveryError, files: [], duplicates: [], summary: deps.appSummary() };
      }
      const pendingRow = deps.findPendingRow(hash);
      let result;
      try {
        result = runManualArchive({
          sources: dialogResult.filePaths,
          invoicesDir: deps.invoicesDirPath(),
          ledgerCsv: deps.ledgerCsvPath(),
          ocrPendingCsv: deps.ocrPendingCsvPath(),
          hash,
          pendingRow,
          removePendingRow: () => deps.rewritePendingCsv((row) => !deps.pendingRowMatchesHash(row, hash)).removed,
        });
      } catch (err) {
        if (err instanceof ArchiveRecoveryError) {
          const error = deps.archiveRecoveryBlockedError();
          deps.recordArchiveRecoveryFailure(path.resolve(deps.invoicesDirPath()), error);
          return { ok: false, canceled: false, ...error, files: [], duplicates: [], summary: deps.appSummary() };
        }
        throw err;
      }

      if (!result.ok) {
        // COPY-18：文件已存在 / 全部重复不是「归档失败」，用专用 code 与文案。
        const isDup = result.code === 'manual_archive_all_duplicates';
        const summaryPart = deps.tryAppSummary();
        return {
          ok: false,
          canceled: false,
          code: result.code ?? 'manual_archive_failed',
          message: result.message
            ?? (isDup ? '选择的文件都已经归档过了，没有新增内容。' : '文件没有归档成功，待确认记录保持不变。'),
          ...(result.detail ? { detail: result.detail } : {}),
          files: [],
          duplicates: result.duplicates,
          pendingRemoved: result.pendingRemoved ?? 0,
          ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
          ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
        };
      }

      const pendingRemoved = result.pendingRemoved ?? 0;
      const skipped = result.duplicates.length > 0 ? `，跳过 ${result.duplicates.length} 个已归档文件` : '';
      // COPY-04：明确区分「记录是否已从待确认移除」。
      let message: string;
      if (result.message) {
        message = result.message;
      } else if (pendingRemoved > 0) {
        message = `文件已保存，并已从「待确认」移除${skipped}。`;
      } else {
        message = `文件已保存，并会在下次识别时处理；但这封邮件仍在「待确认」中${skipped}。请刷新列表后重试移除。`;
      }
      const summaryPart = deps.tryAppSummary();
      return {
        ok: true,
        canceled: false,
        code: result.code
          ?? (pendingRemoved > 0 ? 'manual_archive_done' : 'manual_archive_pending_not_updated'),
        message,
        files: result.files.map((file) => file.filename),
        duplicates: result.duplicates,
        pendingRemoved,
        ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
        ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
        ...(summaryPart.warning ? { warning: summaryPart.warning } : {}),
      };
    } finally {
      gate.lease.release();
    }
  });
}
