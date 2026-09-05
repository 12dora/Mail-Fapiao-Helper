/**
 * 清理重复发票。
 *
 * 两步：打开时先跑一次 apply:false 的试算，把要保留和要移除的列出来；用户确认后
 * 才跑 apply:true。被移除的文件是移进隔离目录，不是删除，所以确认按钮不用红色。
 * 金额或销售方对不上的组标成冲突，后端不会动它们。
 */
import { Alert, Button, Collapse, Modal, Spin, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { bridge, primeSummary, reloadSummary } from '../../bridge/index.js';
import type { DedupeGroup, DedupeReport } from '../../bridge/index.js';
import { notifyResult, useBusy } from '../../components/index.js';
import { LibraryTable } from './LibraryTable.js';

export interface DedupeModalProps {
  open: boolean;
  onClose: () => void;
}

const COLUMNS: ColumnsType<DedupeGroup> = [
  {
    title: '发票号',
    dataIndex: 'invoiceNo',
    width: 190,
    render: (value: string) => <span style={{ fontFamily: 'var(--mfh-mono)' }}>{value || '—'}</span>,
  },
  {
    title: '保留',
    dataIndex: ['kept', 'filename'],
    ellipsis: true,
    render: (value: string) => <span style={{ fontFamily: 'var(--mfh-mono)' }}>{value || '—'}</span>,
  },
  {
    title: '移除',
    key: 'removed',
    width: 96,
    render: (_: unknown, group: DedupeGroup) => (
      <Tooltip title={group.removed.map((item) => item.filename).join('\n')}>
        <span className="mfh-num">{group.removed.length} 份</span>
      </Tooltip>
    ),
  },
  {
    title: '冲突',
    key: 'conflict',
    width: 108,
    render: (_: unknown, group: DedupeGroup) =>
      group.conflict ? (
        <Tooltip title={group.conflictReason}>
          <Tag color="warning" bordered={false}>
            需要人工核对
          </Tag>
        </Tooltip>
      ) : (
        '—'
      ),
  },
];

export function DedupeModal({ open, onClose }: DedupeModalProps): JSX.Element {
  const { busy } = useBusy();
  const [report, setReport] = useState<DedupeReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setReport(null);
    setScanning(true);
    void bridge
      .dedupe({ by: 'invoice-no', apply: false })
      .then((result) => {
        if (!alive) return;
        if (result.ok) setReport(result.report ?? null);
        else notifyResult(result, { success: '已检查', failure: '检查未完成' });
      })
      .finally(() => {
        if (alive) setScanning(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  async function apply(): Promise<void> {
    setApplying(true);
    try {
      const result = await bridge.dedupe({ by: 'invoice-no', apply: true });
      notifyResult(result, { success: '已清理重复发票', failure: '清理未完成' });
      primeSummary(result.summary);
      await reloadSummary();
      if (result.ok) onClose();
      else setReport(result.report ?? report);
    } finally {
      setApplying(false);
    }
  }

  const groups = report?.groups ?? [];
  const removable = report?.redundant ?? 0;
  const skipped = report?.skipped ?? [];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="清理重复发票"
      width={760}
      destroyOnClose
      maskClosable={!applying}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={applying}>
          取消
        </Button>,
        <Button
          key="apply"
          type="primary"
          loading={applying}
          disabled={busy || scanning || removable === 0}
          onClick={() => void apply()}
        >
          确认清理
        </Button>,
      ]}
    >
      {scanning ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
          <Spin />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--mfh-text-dim)' }}>
            {groups.length > 0
              ? `发现 ${groups.length} 组同号发票，可移出 ${removable} 份。保留的一份留在归档目录。`
              : '没有同号重复的发票。'}
          </div>
          {report && report.conflicts > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`${report.conflicts} 组金额或销售方不一致，这次不会清理。`}
            />
          )}
          {groups.length > 0 && (
            <LibraryTable<DedupeGroup>
              rows={groups}
              columns={COLUMNS}
              rowKey={(group) => group.invoiceNo}
              pagination={groups.length > 20}
              defaultPageSize={20}
              scrollX={false}
              emptyText="没有同号重复的发票"
            />
          )}
          {skipped.length > 0 && (
            <Collapse
              size="small"
              ghost
              items={[
                {
                  key: 'skipped',
                  label: `跳过 ${skipped.length} 份`,
                  children: (
                    <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
                      {skipped.map((item) => (
                        <li key={item.filename}>
                          <span style={{ fontFamily: 'var(--mfh-mono)' }}>{item.filename}</span>
                          <span style={{ color: 'var(--mfh-text-dim)', marginInlineStart: 8 }}>{item.reason}</span>
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
