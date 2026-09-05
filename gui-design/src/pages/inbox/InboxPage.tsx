import { FolderOpenOutlined, LinkOutlined, PaperClipOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Empty, Space, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { bridge, useSummary } from '../../bridge/index.js';
import type { InboxRow, InboxStatus } from '../../bridge/index.js';
import { DataTable, PageHeader, StatusTag, notifyResult, statusLabel } from '../../components/index.js';
import type { TableFilter } from '../../components/index.js';
import { navigate } from '../../router.js';
import { MailDrawer } from './MailDrawer.js';

const STATUS_ORDER: InboxStatus[] = ['archived', 'pending', 'unprocessed', 'ignored'];

const STATUS_FILTERS: TableFilter<InboxRow>[] = STATUS_ORDER.map((status) => ({
  key: status,
  label: statusLabel(status),
  test: (row) => row.status === status,
}));

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const COLUMNS: ColumnsType<InboxRow> = [
  {
    title: '时间',
    dataIndex: 'date',
    width: 150,
    sorter: (a, b) => compare(a.date, b.date),
    defaultSortOrder: 'descend',
  },
  {
    title: '发件人',
    dataIndex: 'from',
    width: 220,
    ellipsis: true,
    sorter: (a, b) => compare(a.from, b.from),
  },
  {
    title: '主题',
    dataIndex: 'subject',
    ellipsis: { showTitle: false },
    render: (value: string) => (
      <Tooltip title={value} placement="topLeft">
        <span>{value || '无主题'}</span>
      </Tooltip>
    ),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 96,
    render: (value: InboxStatus) => <StatusTag status={value} />,
  },
  {
    title: '发票',
    dataIndex: 'documentCount',
    width: 72,
    align: 'right',
    sorter: (a, b) => a.documentCount - b.documentCount,
    render: (value: number) => (value > 0 ? value : '—'),
  },
  {
    title: '附件/链接',
    key: 'assets',
    width: 110,
    render: (_value, row) => {
      if (!row.hasAttachment && row.bodyLinkCount <= 0) return <span style={{ opacity: 0.45 }}>—</span>;
      return (
        <Space size={12}>
          {row.hasAttachment ? (
            <Tooltip title="有附件">
              <PaperClipOutlined style={{ opacity: 0.65 }} />
            </Tooltip>
          ) : null}
          {row.bodyLinkCount > 0 ? (
            <Tooltip title="正文链接">
              <span className="mfh-num" style={{ opacity: 0.65 }}>
                <LinkOutlined /> {row.bodyLinkCount}
              </span>
            </Tooltip>
          ) : null}
        </Space>
      );
    },
  },
];

function openSamples(): void {
  void bridge.openPath({ location: 'samples' }).then((result) => {
    if (!result.ok) notifyResult(result, { success: '已打开', failure: '打不开邮件目录' });
  });
}

export function InboxPage(): JSX.Element {
  const { data: summary, loading, reload } = useSummary();
  const [row, setRow] = useState<InboxRow | null>(null);
  const [open, setOpen] = useState(false);

  const inbox = summary?.inbox;
  const rows = inbox?.rows ?? [];
  const empty = Boolean(summary) && rows.length === 0;

  return (
    <>
      <PageHeader
        title="邮件记录"
        subtitle={inbox ? `共 ${inbox.total} 封 · 含附件 ${inbox.withAttachment}` : '正在读取本机数据'}
        actions={
          <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>
              刷新
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={openSamples}>
              打开邮件目录
            </Button>
          </Space>
        }
      />

      <div className="mfh-scroll" style={empty ? { alignItems: 'center', justifyContent: 'center' } : undefined}>
        {empty ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有邮件记录">
            <Button type="primary" onClick={() => navigate('dashboard')}>
              去处理
            </Button>
          </Empty>
        ) : (
          <DataTable<InboxRow>
            rows={rows}
            columns={COLUMNS}
            rowKey={(item) => item.mailHash}
            loading={loading && !summary}
            searchKeys={['from', 'subject', 'messageId']}
            searchPlaceholder="搜索发件人或主题"
            filters={STATUS_FILTERS}
            emptyText="没有符合条件的邮件"
            onOpen={(item) => {
              setRow(item);
              setOpen(true);
            }}
          />
        )}
      </div>

      <MailDrawer row={row} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
