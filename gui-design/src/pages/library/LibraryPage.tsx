/**
 * 发票库页：已归档文件的总表。
 *
 * 数据全部来自 summary.library.rows（一次取回，搜索与分页都在渲染层做）。
 * 默认只看发票——附属材料（费用汇总单一类）报销用不上，压在「附属材料」筛选里，
 * 判定规则见 documentType.ts。
 */
import { Button, Card, Empty, Space, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useDeferredValue, useMemo, useState } from 'react';
import { useSummary } from '../../bridge/index.js';
import type { InvoiceRow } from '../../bridge/index.js';
import {
  DataTable,
  PageHeader,
  StatusTag,
  filterRows,
  humanizeDocumentType,
  isSupportingDocument,
} from '../../components/index.js';
import type { TableFilter } from '../../components/index.js';
import { navigate } from '../../router.js';
import { DedupeModal } from './DedupeModal.js';
import { InvoiceDrawer } from './InvoiceDrawer.js';
import { LibraryActions } from './LibraryActions.js';

/** 默认落在「仅发票」上：附属材料要显式切过去才看得到。 */
const DEFAULT_CHIP = 'invoice';

/** 自带一个「全部」，所以要关掉 DataTable 内置的那个，免得出现两遍。 */
const CHIPS: TableFilter<InvoiceRow>[] = [
  { key: 'invoice', label: '仅发票', test: (row) => !isSupportingDocument(row) },
  { key: 'recognized', label: '已识别', test: (row) => row.status === '完整' && !isSupportingDocument(row) },
  { key: 'incomplete', label: '待补充', test: (row) => row.status === '信息不完整' && !isSupportingDocument(row) },
  { key: 'failed', label: '识别失败', test: (row) => row.status === '识别失败' && !isSupportingDocument(row) },
  { key: 'duplicate', label: '重复', test: (row) => row.duplicateCount > 1 },
  { key: 'supporting', label: '附属材料', test: (row) => isSupportingDocument(row) },
  { key: 'all', label: '全部', test: () => true },
];

const SEARCH_KEYS: (keyof InvoiceRow)[] = ['seller', 'invoiceNo', 'filename', 'subject'];

function mono(value: string): JSX.Element {
  return <span style={{ fontFamily: 'var(--mfh-mono)' }}>{value || '—'}</span>;
}

const COLUMNS: ColumnsType<InvoiceRow> = [
  { title: '日期', dataIndex: 'date', width: 108, render: (value: string) => value || '—' },
  { title: '销售方', dataIndex: 'seller', ellipsis: true, render: (value: string) => value || '待识别' },
  {
    title: '发票号',
    dataIndex: 'invoiceNo',
    width: 218,
    render: (value: string, row: InvoiceRow) => (
      <Space size={6}>
        {mono(value)}
        {row.duplicateCount > 1 && (
          <Tag color="warning" bordered={false} style={{ marginInlineEnd: 0 }}>
            重复 ×{row.duplicateCount}
          </Tag>
        )}
      </Space>
    ),
  },
  {
    title: '金额',
    dataIndex: 'amount',
    width: 112,
    align: 'right',
    render: (value: string) => <span className="mfh-num">{value ? `¥ ${value}` : '—'}</span>,
  },
  { title: '类型', key: 'type', width: 104, render: (_: unknown, row: InvoiceRow) => humanizeDocumentType(row) },
  {
    title: '状态',
    dataIndex: 'status',
    width: 104,
    render: (value: string) => <StatusTag status={value} />,
  },
  { title: '文件', dataIndex: 'filename', ellipsis: true, render: (value: string) => mono(value) },
];

export function LibraryPage(): JSX.Element {
  const { data: summary, loading } = useSummary();

  const [query, setQuery] = useState('');
  const [chip, setChip] = useState(DEFAULT_CHIP);
  const [active, setActive] = useState<InvoiceRow | null>(null);
  const [dedupeOpen, setDedupeOpen] = useState(false);

  const rows = useMemo(() => summary?.library.rows ?? [], [summary]);

  /* 导出 CSV 要的是「用户现在看到的这些行」，所以搜索词和筛选项由页面持有，
     可见行在这里算一次，连同 `preFiltered` 一起交给表格——表格再筛一遍只会得到
     同一个结果，却要在每次按键上多走一趟十万行。
     筛选走延后值：输入框保持即时响应，重算让路。 */
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(
    () => filterRows(rows, { query: deferredQuery, filterKey: chip, filters: CHIPS, searchKeys: SEARCH_KEYS }),
    [rows, deferredQuery, chip],
  );

  const counts = useMemo(() => {
    let invoices = 0;
    let incomplete = 0;
    let duplicated = 0;
    for (const row of rows) {
      if (!isSupportingDocument(row)) invoices++;
      if (row.status === '信息不完整') incomplete++;
      if (row.duplicateCount > 1) duplicated++;
    }
    return { invoices, incomplete, duplicated };
  }, [rows]);

  const empty = !loading && rows.length === 0;

  return (
    <>
      <PageHeader
        title="发票库"
        subtitle={
          summary
            ? `发票 ${counts.invoices} · 待补充 ${counts.incomplete} · 重复 ${counts.duplicated}`
            : '正在读取本机数据'
        }
        actions={<LibraryActions visible={visible} onDedupe={() => setDedupeOpen(true)} />}
      />

      <div className="mfh-scroll" style={empty ? { alignItems: 'center', justifyContent: 'center' } : undefined}>
        {empty ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有归档的发票">
            <Button type="primary" onClick={() => navigate('dashboard')}>
              去处理
            </Button>
          </Empty>
        ) : (
          <Card size="small">
            <DataTable<InvoiceRow>
              rows={visible}
              preFiltered
              columns={COLUMNS}
              rowKey={(row) => row.filename}
              loading={loading && !summary}
              searchKeys={SEARCH_KEYS}
              searchPlaceholder="搜索销售方、发票号或文件名"
              query={query}
              onQueryChange={setQuery}
              filters={CHIPS}
              filterKey={chip}
              onFilterChange={setChip}
              hideAllChip
              onOpen={setActive}
              scrollX={940}
              emptyText="没有符合条件的发票"
              testId="table-library"
            />
          </Card>
        )}
      </div>

      <InvoiceDrawer row={active} onClose={() => setActive(null)} />
      <DedupeModal open={dedupeOpen} onClose={() => setDedupeOpen(false)} />
    </>
  );
}
