/**
 * 待确认页：一张打平的队列表，每一行都能打开原始邮件并看懂自己为什么在这里。
 *
 * 分组只当筛选和原因标签用，不再折叠成手风琴——用户要的是「一眼看完 + 逐封处理」，
 * 而不是先展开一个分组才知道里面有什么。
 */
import { FolderOpenOutlined, MailOutlined, MoreOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Dropdown, Popconfirm, Result, Space, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { bridge, useSummary } from '../../bridge/index.js';
import { DataTable, PageHeader, StatusTag, notifyResult } from '../../components/index.js';
import type { TableFilter } from '../../components/index.js';
import { PendingDetailDrawer } from './PendingDetailDrawer.js';
import { flattenGroups, usePendingActions, type PendingActions, type PendingQueueRow } from './usePendingActions.js';

const DIM_ELLIPSIS = {
  color: 'var(--mfh-text-dim)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/** 行尾的三个图标：打开邮件、重试、更多。行本身可点开抽屉，所以要拦住冒泡。 */
function RowActions({ row, actions }: { row: PendingQueueRow; actions: PendingActions }): JSX.Element {
  const menu = {
    items: [
      { key: 'reveal', label: '显示文件' },
      { key: 'archive', label: '手动归档', disabled: actions.disabled },
      { type: 'divider' as const },
      { key: 'ignore', label: '忽略', danger: true, disabled: actions.disabled },
    ],
    onClick: ({ key, domEvent }: { key: string; domEvent: { stopPropagation: () => void } }) => {
      domEvent.stopPropagation();
      if (key === 'reveal') void actions.revealMail(row);
      if (key === 'archive') void actions.manualArchive(row);
      if (key === 'ignore') actions.ignore(row);
    },
  };

  return (
    <span style={{ display: 'flex', gap: 2 }} onClick={(event) => event.stopPropagation()}>
      <Tooltip title="打开邮件">
        <Button
          type="text"
          size="small"
          aria-label="打开邮件"
          icon={<MailOutlined />}
          onClick={() => void actions.openMail(row)}
        />
      </Tooltip>
      <Tooltip title="重试">
        <Button
          type="text"
          size="small"
          aria-label="重试"
          icon={<ReloadOutlined />}
          disabled={actions.disabled}
          onClick={() => void actions.retry(row)}
        />
      </Tooltip>
      <Dropdown trigger={['click']} menu={menu}>
        <Button type="text" size="small" aria-label="更多" icon={<MoreOutlined />} />
      </Dropdown>
    </span>
  );
}

function buildColumns(actions: PendingActions): ColumnsType<PendingQueueRow> {
  return [
    { title: '时间', dataIndex: 'date', width: 148 },
    { title: '发件人', dataIndex: 'from', width: 176, ellipsis: true },
    { title: '主题', dataIndex: 'subject', ellipsis: true },
    {
      title: '原因',
      dataIndex: 'groupTitle',
      width: 300,
      render: (_: string, row: PendingQueueRow) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
          <StatusTag status={row.groupAction} label={row.groupTitle} />
          <span style={DIM_ELLIPSIS}>{row.groupMessage}</span>
        </span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 112,
      render: (_: unknown, row: PendingQueueRow) => <RowActions row={row} actions={actions} />,
    },
  ];
}

function HeaderActions({ total, actions, loading, reload }: {
  total: number;
  actions: PendingActions;
  loading: boolean;
  reload: () => Promise<void>;
}): JSX.Element {
  return (
    <Space>
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>
        刷新
      </Button>
      <Button
        icon={<FolderOpenOutlined />}
        onClick={() => {
          void bridge.openPath({ location: 'pending' }).then((result) => {
            if (!result.ok) notifyResult(result, { success: '已打开', failure: '打开失败' });
          });
        }}
      >
        打开待确认目录
      </Button>
      <Popconfirm
        title="重试全部待确认邮件？"
        description={`共 ${total} 封，可能需要几分钟。`}
        okText="重试"
        cancelText="取消"
        onConfirm={() => void actions.retryAll()}
      >
        <Button type="primary" disabled={actions.disabled || total === 0} loading={actions.working}>
          全部重试
        </Button>
      </Popconfirm>
    </Space>
  );
}

export function PendingPage(): JSX.Element {
  const { data: summary, loading, reload } = useSummary();
  const [active, setActive] = useState<PendingQueueRow | null>(null);
  const actions = usePendingActions();

  const groups = useMemo(() => summary?.pending.groups ?? [], [summary]);
  const total = summary?.pending.total ?? 0;
  const rows = useMemo(() => flattenGroups(groups), [groups]);
  const columns = useMemo(() => buildColumns(actions), [actions]);
  const filters = useMemo<TableFilter<PendingQueueRow>[]>(
    () =>
      groups.map((group) => ({
        key: group.key,
        label: group.title,
        test: (row) => row.groupKey === group.key,
      })),
    [groups],
  );

  // 抽屉开着时队列可能被改写（重试成功 / 已忽略），始终拿最新那一行渲染。
  const current = active ? rows.find((row) => row.hash === active.hash) ?? null : null;
  const empty = !loading && total === 0;

  return (
    <>
      <PageHeader
        title="待确认"
        subtitle={loading && !summary ? '正在读取本机数据' : total > 0 ? `${total} 封邮件需要处理` : undefined}
        actions={<HeaderActions total={total} actions={actions} loading={loading} reload={reload} />}
      />

      <div className="mfh-scroll">
        {empty ? (
          <Result status="success" title="没有需要确认的邮件" subTitle="所有邮件都已处理完成" />
        ) : (
          <Card size="small">
            <DataTable<PendingQueueRow>
              rows={rows}
              columns={columns}
              rowKey={(row) => `${row.groupKey}:${row.hash}`}
              loading={loading && !summary}
              searchKeys={['from', 'subject']}
              searchPlaceholder="搜索发件人或主题"
              filters={filters}
              onOpen={(row) => setActive(row)}
              defaultPageSize={20}
              emptyText="没有符合条件的邮件"
            />
          </Card>
        )}
      </div>

      <PendingDetailDrawer row={current} onClose={() => setActive(null)} actions={actions} />
    </>
  );
}
