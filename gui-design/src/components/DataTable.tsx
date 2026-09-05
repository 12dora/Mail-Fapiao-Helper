import { Empty, Input, Segmented, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useRef, useState, type ReactNode } from 'react';

export interface TableFilter<T> {
  key: string;
  label: string;
  test: (row: T) => boolean;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: ColumnsType<T>;
  rowKey: (row: T) => string;
  loading?: boolean;
  /** 参与搜索的字段；不传时自动取所有带 dataIndex 的列。 */
  searchKeys?: (keyof T)[];
  searchPlaceholder?: string;
  /** 状态分段筛选；组件会自动在最前面补一个「全部」。 */
  filters?: TableFilter<T>[];
  /** 行点击。传了才会显示手型光标。 */
  onOpen?: (row: T) => void;
  /** 工具条右侧的按钮区。 */
  toolbarExtra?: ReactNode;
  emptyText?: string;
  defaultPageSize?: 20 | 50 | 100;
  /** 关掉分页（例如只展示最近几条的小表）。 */
  pagination?: boolean;
}

function columnKeys<T>(columns: ColumnsType<T>): (keyof T)[] {
  const keys: (keyof T)[] = [];
  for (const col of columns) {
    const dataIndex = (col as { dataIndex?: unknown }).dataIndex;
    if (typeof dataIndex === 'string') keys.push(dataIndex as keyof T);
  }
  return keys;
}

/**
 * 所有列表的统一外壳：搜索 + 分段筛选 + 分页 + 空状态。
 *
 * 搜索与筛选都在渲染层的完整数据上做——summary 一次性把行全部取回，
 * 所以不需要再向用户解释「只筛选已加载的记录」。
 */
export function DataTable<T extends object>({
  rows,
  columns,
  rowKey,
  loading,
  searchKeys,
  searchPlaceholder = '搜索',
  filters,
  onOpen,
  toolbarExtra,
  emptyText = '暂无记录',
  defaultPageSize = 50,
  pagination = true,
}: DataTableProps<T>): JSX.Element {
  const [query, setQuery] = useState('');
  const [filterKey, setFilterKey] = useState('all');
  const [pageSize, setPageSize] = useState<number>(defaultPageSize);
  const wrapper = useRef<HTMLDivElement>(null);

  const keys = useMemo(() => searchKeys ?? columnKeys(columns), [searchKeys, columns]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const active = filters?.find((f) => f.key === filterKey);
    return rows.filter((row) => {
      if (active && !active.test(row)) return false;
      if (!needle) return true;
      return keys.some((key) => String(row[key] ?? '').toLowerCase().includes(needle));
    });
  }, [rows, query, filterKey, filters, keys]);

  const segments = filters?.length
    ? [{ label: '全部', value: 'all' }, ...filters.map((f) => ({ label: f.label, value: f.key }))]
    : null;

  const showToolbar = Boolean(keys.length || segments || toolbarExtra);

  return (
    <div ref={wrapper}>
      {showToolbar && (
        <div className="mfh-table__toolbar">
          {keys.length > 0 && (
            <Input.Search
              allowClear
              size="small"
              style={{ width: 220 }}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {segments && (
            <Segmented size="small" options={segments} value={filterKey} onChange={(v) => setFilterKey(String(v))} />
          )}
          <span className="mfh-table__toolbar-spacer" />
          {toolbarExtra}
        </div>
      )}
      <Table<T>
        className={onOpen ? 'mfh-table mfh-table--clickable' : 'mfh-table'}
        size="small"
        rowKey={rowKey}
        columns={columns}
        dataSource={visible}
        loading={loading}
        sticky={{ getContainer: () => wrapper.current?.closest<HTMLElement>('.mfh-scroll') ?? window }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} /> }}
        onRow={
          onOpen
            ? (row) => ({
                onClick: () => onOpen(row),
              })
            : undefined
        }
        pagination={
          pagination
            ? {
                size: 'small',
                pageSize,
                pageSizeOptions: [20, 50, 100],
                showSizeChanger: true,
                onShowSizeChange: (_current, size) => setPageSize(size),
                showTotal: (total) => `共 ${total} 条`,
                hideOnSinglePage: false,
              }
            : false
        }
      />
    </div>
  );
}
