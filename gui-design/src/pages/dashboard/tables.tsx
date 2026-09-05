/** 首页下半屏的两张表：本次结果与最近运行。 */
import { Card } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AppSummary, BatchRow, RunHistoryEntry } from '../../bridge/index.js';
import { DataTable, StatusTag } from '../../components/index.js';

function formatDuration(ms: number): string {
  if (!ms) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const BATCH_COLUMNS: ColumnsType<BatchRow> = [
  { title: '时间', dataIndex: 'date', width: 150 },
  { title: '发件人', dataIndex: 'from', width: 220, ellipsis: true },
  { title: '主题', dataIndex: 'subject', ellipsis: true },
  {
    title: '附件',
    dataIndex: 'hasAttachment',
    width: 80,
    render: (value: boolean) => (value ? '有' : '—'),
  },
];

const HISTORY_COLUMNS: ColumnsType<RunHistoryEntry> = [
  { title: '时间', dataIndex: 'time', width: 150 },
  { title: '操作', dataIndex: 'title', width: 140 },
  {
    title: '状态',
    dataIndex: 'status',
    width: 100,
    render: (value: RunHistoryEntry['status']) => <StatusTag status={value} />,
  },
  { title: '结果', dataIndex: 'message', ellipsis: true },
  {
    title: '用时',
    dataIndex: 'durationMs',
    width: 100,
    align: 'right',
    render: (value: number) => formatDuration(value),
  },
];

export function BatchCard({ rows }: { rows: BatchRow[] }): JSX.Element {
  return (
    <Card title="本次结果" size="small">
      <DataTable<BatchRow>
        rows={rows}
        columns={BATCH_COLUMNS}
        rowKey={(row) => row.messageId}
        searchKeys={['from', 'subject']}
        searchPlaceholder="搜索发件人或主题"
        defaultPageSize={20}
        emptyText="本次运行还没有新邮件"
      />
    </Card>
  );
}

export function HistoryCard({ summary, loading }: { summary: AppSummary | null; loading: boolean }): JSX.Element {
  return (
    <Card title="最近运行" size="small">
      <DataTable<RunHistoryEntry>
        rows={summary?.history ?? []}
        columns={HISTORY_COLUMNS}
        rowKey={(row) => row.id}
        searchKeys={['title', 'message']}
        searchPlaceholder="搜索操作或结果"
        defaultPageSize={20}
        loading={loading}
        emptyText="还没有运行记录"
      />
    </Card>
  );
}
