import { LinkOutlined, PaperClipOutlined } from '@ant-design/icons';
import { Alert, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CSSProperties, ReactNode } from 'react';
import { bridge } from '../../bridge/index.js';
import type { InvoiceRow, MailAttachment, MailDetail, MailHistoryEntry, MailLink, OpKind } from '../../bridge/index.js';
import { DataTable, StatusTag, notify, notifyResult, opLabel } from '../../components/index.js';
import { formatBytes, formatType, splitLink } from './format.js';

const DIM = 'var(--mfh-text-dim)';

const boxStyle: CSSProperties = {
  border: '1px solid var(--mfh-border)',
  borderRadius: 8,
  overflow: 'hidden',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  borderTop: '1px solid var(--mfh-border)',
  minWidth: 0,
};

const clipStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** 抽屉里的一段：小标题 + 计数 + 内容。 */
export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: DIM }}>{title}</span>
        {typeof count === 'number' ? (
          <span className="mfh-num" style={{ fontSize: 12, color: DIM, opacity: 0.7 }}>
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function AttachmentList({ items }: { items: MailAttachment[] }): JSX.Element {
  return (
    <div style={boxStyle}>
      {items.map((item, index) => (
        <div key={`${item.filename}-${index}`} style={{ ...rowStyle, borderTop: index ? rowStyle.borderTop : 'none' }}>
          <PaperClipOutlined style={{ color: DIM, flex: 'none' }} />
          <span style={clipStyle} title={item.filename}>
            {item.filename}
          </span>
          <span className="mfh-num" style={{ flex: 'none', fontSize: 12, color: DIM }}>
            {[formatType(item.contentType), formatBytes(item.size)].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
    </div>
  );
}

function copyLink(url: string): void {
  void bridge.copyText(url).then((result) => {
    if (result.ok) notify.success('链接已复制');
    else notifyResult(result, { success: '链接已复制', failure: '复制失败' });
  });
}

export function LinkList({ items }: { items: MailLink[] }): JSX.Element {
  return (
    <div style={boxStyle}>
      {items.map((item, index) => {
        const { host, path } = splitLink(item.url);
        return (
          <Tooltip key={`${item.url}-${index}`} title="点击复制链接" placement="left">
            <div
              role="button"
              tabIndex={0}
              style={{ ...rowStyle, borderTop: index ? rowStyle.borderTop : 'none', cursor: 'pointer' }}
              onClick={() => copyLink(item.url)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  copyLink(item.url);
                }
              }}
            >
              <LinkOutlined style={{ color: DIM, flex: 'none' }} />
              <span style={{ flex: 'none' }}>{host}</span>
              <span style={{ ...clipStyle, color: DIM }}>{path}</span>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

const DOCUMENT_COLUMNS: ColumnsType<InvoiceRow> = [
  { title: '文件名', dataIndex: 'filename', ellipsis: true },
  { title: '类型', dataIndex: 'documentType', width: 130, ellipsis: true },
  {
    title: '金额',
    dataIndex: 'amount',
    width: 96,
    align: 'right',
    render: (value: string) => (value ? value : '—'),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 88,
    render: (value: string) => <StatusTag status={value} />,
  },
];

export function DocumentTable({ rows }: { rows: InvoiceRow[] }): JSX.Element {
  return (
    <DataTable<InvoiceRow>
      rows={rows}
      columns={DOCUMENT_COLUMNS}
      rowKey={(row) => row.filename}
      searchKeys={[]}
      pagination={false}
      onOpen={(row) => {
        void bridge.openFile(row.fileHandle).then((result) => {
          if (!result.ok) notifyResult(result, { success: '已打开文件', failure: '打不开这份文件' });
        });
      }}
      emptyText="这封邮件还没有归档文件"
    />
  );
}

export function PendingReason({ pending }: { pending: NonNullable<MailDetail['pending']> }): JSX.Element {
  return (
    <Alert
      type="warning"
      showIcon
      message={pending.userMessage || pending.category}
      description={pending.nextStep || undefined}
    />
  );
}

export function HistoryList({ items }: { items: MailHistoryEntry[] }): JSX.Element {
  return (
    <div style={boxStyle}>
      {items.map((item, index) => (
        <div key={`${item.time}-${index}`} style={{ ...rowStyle, borderTop: index ? rowStyle.borderTop : 'none' }}>
          <span className="mfh-num" style={{ flex: 'none', fontSize: 12, color: DIM }}>
            {item.time}
          </span>
          <span style={{ flex: 'none' }}>{opLabel(item.action as OpKind)}</span>
          <StatusTag status={item.status} />
          <span style={{ ...clipStyle, color: DIM }} title={item.message}>
            {item.message}
          </span>
        </div>
      ))}
    </div>
  );
}
