import type * as ElectronAPI from 'electron';

type TrustedHandler = (
  event: ElectronAPI.IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

type OperationGate =
  | { ok: true; lease: { release(): void } }
  | { ok: false; response: unknown };

export interface ResetHandlerDeps {
  handleTrusted(channel: string, handler: TrustedHandler): void;
  performDeveloperReset(event: ElectronAPI.IpcMainInvokeEvent): Promise<Record<string, unknown>>;
  archiveJournalStatus(): Record<string, unknown>;
  quarantineArchiveJournalsWithConfirm(confirm: boolean): Record<string, unknown>;
  asObject(value: unknown): Record<string, unknown>;
  acquireOperation(kind: 'pipeline'): OperationGate;
}

export function registerResetHandlers(deps: ResetHandlerDeps): void {
  const {
    handleTrusted,
    performDeveloperReset,
    archiveJournalStatus,
    quarantineArchiveJournalsWithConfirm,
    asObject,
    acquireOperation,
  } = deps;

  handleTrusted('mfh:developer-reset', async (event) => performDeveloperReset(event));

  /** 查看归档 journal 残留状态（不写盘）。 */
  handleTrusted('mfh:archive-journal-status', () => archiveJournalStatus());

  /**
   * 用户确认后隔离无法自动清理的归档 journal。
   * payload: { confirm: true }
   * B6b：与其它写路径一样占操作租约；活进程 journal 在实现内按条拒绝搬迁。
   */
  handleTrusted('mfh:archive-journal-quarantine', (_event, payload: unknown) => {
    const raw = asObject(payload);
    // 确认参数先校验，避免无意义占锁。
    if (raw.confirm !== true) {
      return quarantineArchiveJournalsWithConfirm(false);
    }
    // ELEC-02：隔离会 rename journal，必须与 pipeline/ocr/organize 互斥。
    const gate = acquireOperation('pipeline');
    if (!gate.ok) return gate.response;
    try {
      return quarantineArchiveJournalsWithConfirm(true);
    } finally {
      gate.lease.release();
    }
  });
}
