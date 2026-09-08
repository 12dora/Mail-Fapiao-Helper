/**
 * 发票库页头的操作区。
 *
 * 会写盘的动作（识别、仅重试失败项、整理、清理重复）在有任务运行时一律置灰——
 * 长任务在主进程是互斥的，抢跑只会拿到一条失败回执。
 *
 * 「仅重试失败项」只在有识别失败的发票时出现：它只重跑失败的那些行，已经识别
 * 好的结果不动，所以和会清空全部结果的重新识别不是一回事。
 *
 * 「导出 CSV」走系统保存框落盘；主进程没有这个通道时退回复制到剪贴板。
 */
import { FolderOpenOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Space } from 'antd';
import { useState } from 'react';
import { bridge, primeSummary, reloadSummary } from '../../bridge/index.js';
import type { InvoiceRow, TerminalResult } from '../../bridge/index.js';
import { notify, notifyResult, useBusy } from '../../components/index.js';
import { rowsToCsv } from './csv.js';

type WriteAction = 'ocr' | 'retry' | 'organize';

/** 每个写盘动作的调用方式和提示文案放在一起，改一处不会漏另一处。 */
const WRITE_ACTIONS: Record<
  WriteAction,
  { call: () => Promise<TerminalResult>; copy: { success: string; failure: string } }
> = {
  ocr: { call: () => bridge.runOcr({}), copy: { success: '识别完成', failure: '识别未完成' } },
  retry: {
    call: () => bridge.runOcr({ retryFailed: true }),
    copy: { success: '重试完成', failure: '重试未完成' },
  },
  organize: {
    call: () => bridge.organize({ applyRename: false }),
    copy: { success: '已整理归档文件', failure: '整理未完成' },
  },
};

export interface LibraryActionsProps {
  /** 当前列表里可见的行，导出 CSV 用。 */
  visible: readonly InvoiceRow[];
  /** 识别失败的发票数（不含附属材料）；大于 0 才给「仅重试失败项」。 */
  failed: number;
  onDedupe: () => void;
}

export function LibraryActions({ visible, failed, onDedupe }: LibraryActionsProps): JSX.Element {
  const { busy } = useBusy();
  const [action, setAction] = useState<'' | WriteAction | 'export'>('');

  async function run(kind: WriteAction): Promise<void> {
    setAction(kind);
    try {
      const result = await WRITE_ACTIONS[kind].call();
      notifyResult(result, WRITE_ACTIONS[kind].copy);
      primeSummary(result.summary);
      await reloadSummary();
    } finally {
      setAction('');
    }
  }

  function copyCsv(csv: string): void {
    void bridge.copyText(csv).then((result) => {
      if (result.ok) notify.success('已复制 CSV', `共 ${visible.length} 行，粘贴到表格软件即可。`);
      else notifyResult(result, { success: '已复制 CSV', failure: '复制失败' });
    });
  }

  async function exportCsv(): Promise<void> {
    const csv = rowsToCsv(visible);
    if (!bridge.supports('exportCsv')) {
      copyCsv(csv);
      return;
    }
    setAction('export');
    try {
      const result = await bridge.exportCsv({ filename: `发票清单-${new Date().toISOString().slice(0, 10)}.csv`, csv });
      if (result.canceled) return;
      if (result.ok) notify.success('已导出', `共 ${visible.length} 行，已存到 ${result.path ?? '所选位置'}。`);
      else notifyResult(result, { success: '已导出', failure: '导出未完成' });
    } finally {
      setAction('');
    }
  }

  function openArchive(): void {
    void bridge.openPath({ location: 'invoices' }).then((result) => {
      if (!result.ok) notifyResult(result, { success: '已打开', failure: '打开失败' });
    });
  }

  return (
    <Space>
      <Button
        size="small"
        data-testid="action-export-csv"
        disabled={visible.length === 0}
        loading={action === 'export'}
        onClick={() => void exportCsv()}
      >
        导出 CSV
      </Button>
      <Button size="small" icon={<FolderOpenOutlined />} onClick={openArchive}>
        打开归档目录
      </Button>
      {bridge.supports('dedupe') && (
        <Button size="small" data-testid="action-dedupe" disabled={busy} onClick={onDedupe}>
          清理重复
        </Button>
      )}
      <Popconfirm
        title="整理归档文件"
        description="按类型复制到整理目录，不改名、不删除原件。"
        okText="整理"
        cancelText="取消"
        onConfirm={() => void run('organize')}
      >
        <Button size="small" disabled={busy} loading={action === 'organize'}>
          整理文件
        </Button>
      </Popconfirm>
      {failed > 0 && (
        <Button size="small" disabled={busy} loading={action === 'retry'} onClick={() => void run('retry')}>
          仅重试失败项
        </Button>
      )}
      <Button
        size="small"
        type="primary"
        data-testid="action-library-ocr"
        disabled={busy}
        loading={action === 'ocr'}
        onClick={() => void run('ocr')}
      >
        开始识别
      </Button>
    </Space>
  );
}
