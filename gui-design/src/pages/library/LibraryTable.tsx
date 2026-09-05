/**
 * 发票库页专用的表格外壳：components/DataTable 的受控版本。
 *
 * 与共享版的差别只有两点，都是发票库必须的：
 * 1. 搜索词和筛选项由页面持有（共享版把它们锁在组件内部），页面才能知道「当前
 *    可见的行」是哪些——导出 CSV 要用。
 * 2. 分段筛选不自动补「全部」，默认项也可以不是「全部」：发票库默认只看发票，
 *    附属材料要显式切过去。
 *
 * 其余（工具条布局、粘性表头、分页、空状态）与共享版保持一致。等共享版补上
 * `value / onChange / defaultFilterKey` 之后，这个文件应当删掉。
 */
import { Empty, Input, Segmented, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useRef, useState, type ReactNode } from 'react';

export interface TableChip {
  key: string;
  label: string;
}

export interface LibraryTableProps<T> {
  /** 已经过滤好的行；过滤逻辑在页面里，组件只负责显示。 */
  rows: T[];
  columns: ColumnsType<T>;
  rowKey: (row: T) => string;
  loading?: boolean;
  /** 传了 onQueryChange 才显示搜索框。 */
  query?: string;
  onQueryChange?: (next: string) => void;
  searchPlaceholder?: string;
  /** 传了 chips 才显示分段筛选；不会自动补「全部」。 */
  chips?: TableChip[];
  chipKey?: string;
  onChipChange?: (next: string) => void;
  onOpen?: (row: T) => void;
  toolbarExtra?: ReactNode;
  emptyText?: ReactNode;
  defaultPageSize?: number;
  pagination?: boolean;
  /** 表格的最小宽度：数字表示窄于它才横向滚动，false 表示永远不滚（抽屉、弹窗里用）。 */
  scrollX?: number | 'max-content' | false;
}

export function LibraryTable<T extends object>({
  rows,
  columns,
  rowKey,
  loading,
  query,
  onQueryChange,
  searchPlaceholder = '搜索',
  chips,
  chipKey,
  onChipChange,
  onOpen,
  toolbarExtra,
  emptyText = '暂无记录',
  defaultPageSize = 50,
  pagination = true,
  scrollX = 'max-content',
}: LibraryTableProps<T>): JSX.Element {
  const [pageSize, setPageSize] = useState<number>(defaultPageSize);
  const wrapper = useRef<HTMLDivElement>(null);
  const showSearch = typeof onQueryChange === 'function';
  const showChips = Boolean(chips?.length && onChipChange);
  const showToolbar = showSearch || showChips || Boolean(toolbarExtra);

  return (
    <div ref={wrapper}>
      {showToolbar && (
        <div className="mfh-table__toolbar">
          {showSearch && (
            <Input.Search
              allowClear
              size="small"
              style={{ width: 240 }}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => onQueryChange?.(event.target.value)}
            />
          )}
          {showChips && chips && (
            <Segmented
              size="small"
              options={chips.map((chip) => ({ label: chip.label, value: chip.key }))}
              value={chipKey}
              onChange={(value) => onChipChange?.(String(value))}
            />
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
        dataSource={rows}
        loading={loading}
        sticky={{ getContainer: () => wrapper.current?.closest<HTMLElement>('.mfh-scroll') ?? window }}
        scroll={scrollX === false ? undefined : { x: scrollX }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} /> }}
        onRow={onOpen ? (row) => ({ onClick: () => onOpen(row) }) : undefined}
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
