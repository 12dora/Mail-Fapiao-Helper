/**
 * 发票库页头的操作区。
 *
 * 会写盘的三个动作（识别、整理、清理重复）在有任务运行时一律置灰——长任务在主
 * 进程是互斥的，抢跑只会拿到一条失败回执。
 *
 * 「导出 CSV」走系统保存框落盘；主进程没有这个通道时退回复制到剪贴板。
 */
import { FolderOpenOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Space } from 'antd';
import { useState } from 'react';
import { bridge, primeSummary, reloadSummary } from '../../bridge/index.js';
import type { InvoiceRow } from '../../bridge/index.js';
import { notify, notifyResult, useBusy } from '../../components/index.js';
import { rowsToCsv } from './csv.js';

export interface LibraryActionsProps {
  /** 当前列表里可见的行，导出 CSV 用。 */
  visible: readonly InvoiceRow[];
  onDedupe: () => void;
}

export function LibraryActions({ visible, onDedupe }: LibraryActionsProps): JSX.Element {
  const { busy } = useBusy();
  const [action, setAction] = useState<'' | 'ocr' | 'organize' | 'export'>('');

  async function run(kind: 'ocr' | 'organize'): Promise<void> {
    setAction(kind);
    try {
      const result = kind === 'ocr' ? await bridge.runOcr({}) : await bridge.organize({ applyRename: false });
      notifyResult(
        result,
        kind === 'ocr'
          ? { success: '识别完成', failure: '识别未完成' }
          : { success: '已整理归档文件', failure: '整理未完成' },
      );
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
