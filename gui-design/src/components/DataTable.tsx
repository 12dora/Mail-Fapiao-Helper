import { Empty, Input, Segmented, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export const ALL_FILTER_KEY = 'all';

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
  /** 状态分段筛选。默认在最前面补一个「全部」，用 hideAllChip 关掉。 */
  filters?: TableFilter<T>[];
  /** 首屏选中的筛选项；不传时是「全部」。 */
  defaultFilterKey?: string;
  /** 自带「全部」筛选项的页面（发票库）把内置的那个关掉，免得出现两个。 */
  hideAllChip?: boolean;
  /** 受控搜索词。传了就由调用方持有，组件不再自己记。 */
  query?: string;
  onQueryChange?: (next: string) => void;
  /** 受控筛选项。 */
  filterKey?: string;
  onFilterChange?: (next: string) => void;
  /** 行点击。传了才会显示手型光标。 */
  onOpen?: (row: T) => void;
  /** 工具条右侧的按钮区。 */
  toolbarExtra?: ReactNode;
  emptyText?: ReactNode;
  defaultPageSize?: number;
  /**
   * `rows` 已经由调用方用 `filterRows()` 按同一套参数筛过（发票库要把这份结果
   * 直接拿去导出 CSV）。传 true 时表格不再筛第二遍：同一次按键筛两遍，
   * 十万行要多花几十毫秒，而两遍算出来的必然是同一个结果。
   */
  preFiltered?: boolean;
  /** 关掉分页（例如只展示最近几条的小表）。 */
  pagination?: boolean;
  /** 表格最小宽度：数字表示窄于它才横向滚动，false 表示永不滚（抽屉、弹窗里用）。 */
  scrollX?: number | 'max-content' | false;
  /** 测试用的稳定钩子：外层拿 `data-testid`，搜索框拿 `<testId>-search`。 */
  testId?: string;
}

function columnKeys<T>(columns: ColumnsType<T>): (keyof T)[] {
  const keys: (keyof T)[] = [];
  for (const col of columns) {
    const dataIndex = (col as { dataIndex?: unknown }).dataIndex;
    if (typeof dataIndex === 'string') keys.push(dataIndex as keyof T);
  }
  return keys;
}

export interface FilterRowsOptions<T> {
  query: string;
  filterKey: string;
  filters?: TableFilter<T>[];
  searchKeys: (keyof T)[];
}

/**
 * 每一行的可搜索文本（小写、按字段拼起来）只算一次。
 *
 * 行对象来自 summary store，是不可变快照，所以可以按对象缓存：连续敲键时十万行
 * 的 toLowerCase 只在第一次发生。WeakMap 让行被丢弃时缓存跟着走。
 */
const SEARCH_TEXT = new WeakMap<object, Map<string, string>>();

function searchTextOf<T>(row: T, keys: (keyof T)[], cacheKey: string): string {
  // 字段之间垫一个不会出现在搜索框里的分隔符，跨字段拼不出误命中。
  const build = (): string => keys.map((key) => String(row[key] ?? '')).join('\u0000').toLowerCase();
  if (typeof row !== 'object' || row === null) return build();
  let byKeys = SEARCH_TEXT.get(row);
  if (!byKeys) {
    byKeys = new Map();
    SEARCH_TEXT.set(row, byKeys);
  }
  let text = byKeys.get(cacheKey);
  if (text === undefined) {
    text = build();
    byKeys.set(cacheKey, text);
  }
  return text;
}

/**
 * 表格可见行的唯一算法。组件内部用它，页面要「当前看到的这些行」（发票库导出
 * CSV）时也用它，两边不会走岔。
 */
export function filterRows<T>(rows: T[], options: FilterRowsOptions<T>): T[] {
  const needle = options.query.trim().toLowerCase();
  const active = options.filters?.find((item) => item.key === options.filterKey);
  if (!active && !needle) return rows;
  const cacheKey = options.searchKeys.join('\u0000');
  return rows.filter((row) => {
    if (active && !active.test(row)) return false;
    if (!needle) return true;
    return searchTextOf(row, options.searchKeys, cacheKey).includes(needle);
  });
}

interface ChipOption {
  label: string;
  value: string;
}

function chipOptions<T>(filters: TableFilter<T>[] | undefined, hideAll: boolean): ChipOption[] | null {
  if (!filters?.length) return null;
  const own = filters.map((item) => ({ label: item.label, value: item.key }));
  return hideAll ? own : [{ label: '全部', value: ALL_FILTER_KEY }, ...own];
}

/** 筛选项来自数据（待确认页按分组生成），上一次选中的那一项可能已经不存在了。 */
function resolveFilterKey<T>(requested: string, filters: TableFilter<T>[] | undefined): string {
  if (!filters?.length) return requested;
  if (requested === ALL_FILTER_KEY) return requested;
  return filters.some((item) => item.key === requested) ? requested : ALL_FILTER_KEY;
}

/** 受控优先：调用方传了值就由它持有，否则组件自己记一份。 */
function useControlled(
  value: string | undefined,
  fallback: string,
  onChange: ((next: string) => void) | undefined,
): [string, (next: string) => void] {
  const [own, setOwn] = useState(fallback);
  return [value ?? own, onChange ?? setOwn];
}

interface ToolbarProps {
  testId?: string;
  searchable: boolean;
  query: string;
  onQuery: (next: string) => void;
  placeholder: string;
  segments: ChipOption[] | null;
  filterKey: string;
  onFilter: (next: string) => void;
  extra: ReactNode;
}

function TableToolbar({
  testId,
  searchable,
  query,
  onQuery,
  placeholder,
  segments,
  filterKey,
  onFilter,
  extra,
}: ToolbarProps): JSX.Element | null {
  if (!searchable && !segments && !extra) return null;
  return (
    <div className="mfh-table__toolbar">
      {searchable ? (
        <Input.Search
          allowClear
          data-testid={testId ? `${testId}-search` : undefined}
          size="small"
          style={{ width: 240 }}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      ) : null}
      {segments ? (
        <Segmented size="small" options={segments} value={filterKey} onChange={(value) => onFilter(String(value))} />
      ) : null}
      <span className="mfh-table__toolbar-spacer" />
      {extra}
    </div>
  );
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
  defaultFilterKey = ALL_FILTER_KEY,
  hideAllChip = false,
  query: queryProp,
  onQueryChange,
  filterKey: filterKeyProp,
  onFilterChange,
  onOpen,
  toolbarExtra,
  emptyText = '暂无记录',
  defaultPageSize = 50,
  preFiltered = false,
  pagination = true,
  scrollX = 'max-content',
  testId,
}: DataTableProps<T>): JSX.Element {
  const [query, setQuery] = useControlled(queryProp, '', onQueryChange);
  const [requestedKey, setFilterKey] = useControlled(filterKeyProp, defaultFilterKey, onFilterChange);
  const [pageSize, setPageSize] = useState<number>(defaultPageSize);
  const [page, setPage] = useState(1);
  const wrapper = useRef<HTMLDivElement>(null);

  const keys = useMemo(() => searchKeys ?? columnKeys(columns), [searchKeys, columns]);
  const filterKey = resolveFilterKey(requestedKey, filters);

  // 输入框拿到的是即时值，筛选走延后值：敲键时先把光标喂饱，大表的重算让路。
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(
    () => (preFiltered ? rows : filterRows(rows, { query: deferredQuery, filterKey, filters, searchKeys: keys })),
    [preFiltered, rows, deferredQuery, filterKey, filters, keys],
  );

  /* 分页受控。antd 自己那份 current 只在越界时才夹回来，于是「在第 5 页搜索」
     会落在结果的第 5 页上——用户以为没搜到。查询或筛选一变就回到第 1 页；
     普通的数据刷新（行变多变少）只夹到最后一页，不打断当前浏览位置。 */
  useEffect(() => {
    setPage(1);
  }, [query, filterKey]);
  const lastPage = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, lastPage);

  return (
    <div ref={wrapper} data-testid={testId}>
      <TableToolbar
        testId={testId}
        searchable={keys.length > 0}
        query={query}
        onQuery={setQuery}
        placeholder={searchPlaceholder}
        segments={chipOptions(filters, hideAllChip)}
        filterKey={filterKey}
        onFilter={setFilterKey}
        extra={toolbarExtra}
      />
      <Table<T>
        className={onOpen ? 'mfh-table mfh-table--clickable' : 'mfh-table'}
        size="small"
        rowKey={rowKey}
        columns={columns}
        dataSource={visible}
        loading={loading}
        sticky={{ getContainer: () => wrapper.current?.closest<HTMLElement>('.mfh-scroll') ?? window }}
        scroll={scrollX === false ? undefined : { x: scrollX }}
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
                current,
                pageSize,
                pageSizeOptions: [20, 50, 100],
                showSizeChanger: true,
                onChange: (nextPage, nextSize) => {
                  setPage(nextPage);
                  setPageSize(nextSize);
                },
                showTotal: (total) => `共 ${total} 条`,
                hideOnSinglePage: false,
              }
            : false
        }
      />
    </div>
  );
}
