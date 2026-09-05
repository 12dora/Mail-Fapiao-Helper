/**
 * 一份归档文件的详情抽屉。
 *
 * 列表里的行只有台账字段，识别记录、来源邮件、磁盘上的文件状态和同号重复要向
 * 主进程再要一次（mfh:invoice-detail）。取不到时退回用列表行显示，抽屉里的
 * 「打开文件」仍然可用——用户点开一行的目的通常就是打开它。
 */
import { Button, Descriptions, Space, Tag, Typography } from 'antd';
import type { DescriptionsProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { bridge } from '../../bridge/index.js';
import type { InvoiceDetail, InvoiceRow, LedgerRecord, OcrRecord } from '../../bridge/index.js';
import { DetailDrawer, PathText, StatusTag, notify, notifyResult } from '../../components/index.js';
import { navigate } from '../../router.js';
import { humanizeDocumentType, humanizeExtractedBy, humanizeVendor } from './documentType.js';
import { LibraryTable } from './LibraryTable.js';

export interface InvoiceDrawerProps {
  row: InvoiceRow | null;
  onClose: () => void;
}

function dash(value: string | undefined): string {
  const text = (value ?? '').trim();
  return text || '—';
}

function fileSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mono(value: string): JSX.Element {
  return <span style={{ fontFamily: 'var(--mfh-mono)' }}>{dash(value)}</span>;
}

function money(value: string): JSX.Element {
  return <span className="mfh-num">{value ? `¥ ${value}` : '—'}</span>;
}

function openFile(handle: string, reveal: boolean): void {
  if (!handle) return;
  const call = reveal ? bridge.revealFile(handle) : bridge.openFile(handle);
  void call.then((result) => {
    if (!result.ok) notifyResult(result, { success: '已打开', failure: '打开失败' });
  });
}

function ocrItems(row: InvoiceRow, ocr: OcrRecord | null): DescriptionsProps['items'] {
  const extractedBy = humanizeExtractedBy(ocr?.extractedBy ?? '');
  const vendor = humanizeVendor(ocr?.ocrVendor ?? '');
  const error = ocr?.error || row.error;
  return [
    { key: 'type', label: '发票类型', children: humanizeDocumentType(ocr ?? row) },
    { key: 'date', label: '开票日期', children: dash(ocr?.dateValue || row.date) },
    { key: 'seller', label: '销售方', children: dash(ocr?.seller || row.seller) },
    { key: 'amount', label: '金额', children: money(ocr?.amount || row.amount) },
    // 有些引擎把自己的名字同时写进 extractedBy 和 ocrVendor，重复两行没有意义。
    ...(extractedBy !== vendor ? [{ key: 'by', label: '识别方式', children: extractedBy }] : []),
    { key: 'vendor', label: '识别引擎', children: vendor },
    ...(error ? [{ key: 'error', label: '错误', children: error }] : []),
  ];
}

function sourceItems(row: InvoiceRow, ledger: LedgerRecord | null): DescriptionsProps['items'] {
  return [
    { key: 'subject', label: '邮件主题', children: dash(ledger?.subject || row.subject) },
    { key: 'from', label: '发件人', children: dash(ledger?.from || row.from) },
    { key: 'date', label: '日期', children: dash(ledger?.date || row.date) },
    { key: 'source', label: '来源文件', children: dash(ledger?.source || row.source) },
  ];
}

function fileItems(row: InvoiceRow, file: InvoiceDetail['file'] | undefined): DescriptionsProps['items'] {
  return [
    { key: 'name', label: '文件名', children: mono(row.filename) },
    { key: 'format', label: '格式', children: (file?.format || '').toUpperCase() || '—' },
    { key: 'size', label: '大小', children: fileSize(file?.size ?? 0) },
    {
      key: 'exists',
      label: '文件状态',
      children:
        file && !file.exists ? (
          <Tag color="error" bordered={false}>
            已丢失
          </Tag>
        ) : (
          '正常'
        ),
    },
    { key: 'path', label: '位置', children: <PathText path={row.filePath} /> },
  ];
}

const DUPLICATE_COLUMNS: ColumnsType<InvoiceRow> = [
  { title: '文件', dataIndex: 'filename', ellipsis: true, render: (value: string) => mono(value) },
  { title: '日期', dataIndex: 'date', width: 106 },
  { title: '金额', dataIndex: 'amount', width: 104, align: 'right', render: (value: string) => money(value) },
  {
    title: '',
    key: 'action',
    width: 64,
    align: 'right',
    render: (_: unknown, item: InvoiceRow) => (
      <Button type="link" size="small" onClick={() => openFile(item.fileHandle || item.filePath, false)}>
        打开
      </Button>
    ),
  },
];

function Duplicates({ rows }: { rows: InvoiceRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div>
      <Typography.Title level={5} style={{ fontSize: 14, margin: '0 0 8px' }}>
        重复发票
      </Typography.Title>
      <LibraryTable<InvoiceRow>
        rows={rows}
        columns={DUPLICATE_COLUMNS}
        rowKey={(item) => item.filename}
        pagination={false}
        scrollX={false}
        emptyText="没有同号发票"
      />
    </div>
  );
}

/** 打开抽屉时拉一次详情；filename 变了就重新拉，关掉时清空。 */
function useInvoiceDetail(filename: string): { detail: InvoiceDetail | null; loading: boolean } {
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filename) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setDetail(null);
    void bridge
      .invoiceDetail(filename)
      .then((result) => {
        if (!alive) return;
        if (result.ok && result.invoice) setDetail(result.invoice);
        else notifyResult(result, { success: '已读取', failure: '读取详情失败' });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filename]);

  return { detail, loading };
}

function DrawerActions({ row, handle, onClose }: { row: InvoiceRow; handle: string; onClose: () => void }): JSX.Element {
  return (
    <>
      <Button
        size="small"
        disabled={!row.invoiceNo}
        onClick={() => {
          void bridge.copyText(row.invoiceNo).then((result) => {
            if (result.ok) notify.success('发票号已复制');
            else notifyResult(result, { success: '已复制', failure: '复制失败' });
          });
        }}
      >
        复制发票号
      </Button>
      <Button
        size="small"
        disabled={!row.mailHash}
        onClick={() => {
          onClose();
          navigate('inbox', row.mailHash);
        }}
      >
        查看邮件
      </Button>
      <Button size="small" disabled={!handle} onClick={() => openFile(handle, true)}>
        显示文件
      </Button>
      <Button size="small" type="primary" disabled={!handle} onClick={() => openFile(handle, false)}>
        打开文件
      </Button>
    </>
  );
}

export function InvoiceDrawer({ row, onClose }: InvoiceDrawerProps): JSX.Element {
  const { detail, loading } = useInvoiceDetail(row?.filename ?? '');
  const shown = detail?.row ?? row;
  if (!shown) return <DetailDrawer open={false} onClose={onClose} title="" />;
  const handle = detail?.file.handle || shown.fileHandle || shown.filePath;

  return (
    <DetailDrawer
      open
      onClose={onClose}
      width={600}
      loading={loading && !detail}
      title={dash(shown.seller)}
      subtitle={
        <Space size={10} wrap>
          {money(shown.amount)}
          {mono(shown.invoiceNo)}
          <StatusTag status={shown.status} />
        </Space>
      }
      actions={<DrawerActions row={shown} handle={handle} onClose={onClose} />}
    >
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <Descriptions title="识别结果" column={1} size="small" colon={false} items={ocrItems(shown, detail?.ocr ?? null)} />
        <Descriptions title="来源" column={1} size="small" colon={false} items={sourceItems(shown, detail?.ledger ?? null)} />
        <Descriptions title="文件" column={1} size="small" colon={false} items={fileItems(shown, detail?.file)} />
        <Duplicates rows={detail?.duplicates ?? []} />
      </Space>
    </DetailDrawer>
  );
}
