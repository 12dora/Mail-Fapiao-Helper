/**
 * 待确认队列的写操作集合。
 *
 * 页面表格和详情抽屉共用同一套动作，语义按分组的 action 走：
 * retry / refresh_link 都是「重新跑一遍这封邮件」，区别只在失败后给不给下一步提示；
 * manual_archive 打开系统文件选择框；ignore 会改动队列，所以必须先确认。
 */
import { App } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { bridge, primeSummary, reloadSummary } from '../../bridge/index.js';
import type { PendingAction, PendingGroup, PendingRow } from '../../bridge/index.js';
import { notify, notifyResult, useBusy } from '../../components/index.js';

/** 打平后的队列行：保留行自身字段，并带上所属分组的展示信息。 */
export interface PendingQueueRow extends PendingRow {
  groupKey: string;
  groupTitle: string;
  groupAction: PendingAction;
  groupMessage: string;
  groupNextStep: string;
}

export function flattenGroups(groups: PendingGroup[] | undefined): PendingQueueRow[] {
  const rows: PendingQueueRow[] = [];
  for (const group of groups ?? []) {
    for (const row of group.rows) {
      rows.push({
        ...row,
        groupKey: group.key,
        groupTitle: group.title,
        groupAction: group.action,
        groupMessage: group.userMessage || row.userMessage,
        groupNextStep: group.nextStep || row.nextStep,
      });
    }
  }
  return rows;
}

/** 链接失效这一类重试大概率还是取不到，给一句可执行的下一步。 */
const REFRESH_LINK_HINT = '打开原始邮件，按邮件里的入口重新下载。';

export interface PendingActions {
  /** 有长任务在跑，或本页正在执行写操作。 */
  disabled: boolean;
  /** 本页自己发起的写操作还没回来。 */
  working: boolean;
  openMail: (row: PendingQueueRow) => Promise<void>;
  revealMail: (row: PendingQueueRow) => Promise<void>;
  retry: (row: PendingQueueRow) => Promise<void>;
  manualArchive: (row: PendingQueueRow) => Promise<void>;
  ignore: (row: PendingQueueRow) => void;
  retryAll: () => Promise<void>;
}

export function usePendingActions(onDone?: () => void): PendingActions {
  const { modal } = App.useApp();
  const { busy } = useBusy();
  const [working, setWorking] = useState(false);

  const finish = useCallback(async () => {
    await reloadSummary();
    onDone?.();
  }, [onDone]);

  const run = useCallback(async (job: () => Promise<void>) => {
    setWorking(true);
    try {
      await job();
    } finally {
      setWorking(false);
    }
  }, []);

  const openMail = useCallback(async (row: PendingQueueRow) => {
    const result = await bridge.openMail({ hash: row.hash });
    if (!result.ok) {
      notifyResult(result, { success: '已打开邮件', failure: '打开邮件失败' });
      return;
    }
    // 打不开 .eml 时主进程会退到「在文件管理器中显示」，这时得说一声。
    if (result.opened && result.opened !== 'mail') {
      notify.info(result.message?.trim() || '已在文件管理器中显示原始邮件。');
    }
  }, []);

  const revealMail = useCallback(async (row: PendingQueueRow) => {
    const result = await bridge.openMail({ hash: row.hash, reveal: true });
    if (!result.ok) notifyResult(result, { success: '已显示文件', failure: '显示文件失败' });
  }, []);

  const retry = useCallback(
    (row: PendingQueueRow) =>
      run(async () => {
        const result = await bridge.runPipeline({ onlyMail: row.hash, pendingRetry: true });
        primeSummary(result.summary);
        const hint =
          row.groupAction === 'refresh_link' ? row.nextStep || row.groupNextStep || REFRESH_LINK_HINT : '';
        const detail = result.detail?.trim() || result.error?.trim() || hint;
        if (result.ok) notify.success(result.message?.trim() || '已重试', detail || undefined);
        else notify.error(result.message?.trim() || '重试未完成', detail || undefined);
        await finish();
      }),
    [run, finish],
  );

  const manualArchive = useCallback(
    (row: PendingQueueRow) =>
      run(async () => {
        const result = await bridge.pendingManualArchive(row.hash);
        primeSummary(result.summary);
        if (result.canceled) {
          const message = result.message?.trim();
          if (message) notify.info(message);
        } else {
          notifyResult(result, { success: '已归档', failure: '归档未完成' });
        }
        await finish();
      }),
    [run, finish],
  );

  const ignore = useCallback(
    (row: PendingQueueRow) => {
      modal.confirm({
        title: '忽略这封邮件？',
        content: '忽略后不再出现在待确认。',
        okText: '忽略',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () =>
          run(async () => {
            const result = await bridge.pendingIgnore(row.hash);
            primeSummary(result.summary);
            notifyResult(result, { success: '已忽略', failure: '忽略失败' });
            await finish();
          }),
      });
    },
    [modal, run, finish],
  );

  const retryAll = useCallback(
    () =>
      run(async () => {
        const result = await bridge.runPipeline({ pendingRetry: true });
        primeSummary(result.summary);
        notifyResult(result, { success: '已重试', failure: '重试未完成' });
        await finish();
      }),
    [run, finish],
  );

  return useMemo(
    () => ({ disabled: busy || working, working, openMail, revealMail, retry, manualArchive, ignore, retryAll }),
    [busy, working, openMail, revealMail, retry, manualArchive, ignore, retryAll],
  );
}
