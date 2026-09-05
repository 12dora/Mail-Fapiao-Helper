/**
 * 发票库页头的操作区。
 *
 * 会写盘的三个动作（识别、整理、清理重复）在有任务运行时一律置灰——长任务在主
 * 进程是互斥的，抢跑只会拿到一条失败回执。
 *
 * 「导出 CSV」是复制到剪贴板：桥接层没有「另存为」通道，桌面端要真正落盘得先加
 * 一个保存对话框的 IPC。
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
  const [action, setAction] = useState<'' | 'ocr' | 'organize'>('');

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

  function exportCsv(): void {
    void bridge.copyText(rowsToCsv(visible)).then((result) => {
      if (result.ok) notify.success('已复制 CSV', `共 ${visible.length} 行，粘贴到表格软件即可。`);
      else notifyResult(result, { success: '已复制 CSV', failure: '复制失败' });
    });
  }

  function openArchive(): void {
    void bridge.openPath({ location: 'invoices' }).then((result) => {
      if (!result.ok) notifyResult(result, { success: '已打开', failure: '打开失败' });
    });
  }

  return (
    <Space>
      <Button size="small" disabled={visible.length === 0} onClick={exportCsv}>
        导出 CSV
      </Button>
      <Button size="small" icon={<FolderOpenOutlined />} onClick={openArchive}>
        打开归档目录
      </Button>
      {bridge.supports('dedupe') && (
        <Button size="small" disabled={busy} onClick={onDedupe}>
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
      <Button size="small" type="primary" disabled={busy} loading={action === 'ocr'} onClick={() => void run('ocr')}>
        开始识别
      </Button>
    </Space>
  );
}
