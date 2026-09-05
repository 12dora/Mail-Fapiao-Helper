/**
 * 邮件详情抽屉里的公共分区。
 *
 * 邮件记录页和待确认页打开的是同一封邮件，只是入口不同，所以证据区（附件、链接、
 * 归档文件、处理记录）必须长得一样——两边各写一份的时候，附件大小的单位和链接的
 * 显示方式就已经开始各走各的了。
 */
import { LinkOutlined, PaperClipOutlined } from '@ant-design/icons';
import { Alert, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CSSProperties, ReactNode } from 'react';
import { bridge } from '../../bridge/index.js';
import type { InvoiceRow, MailAttachment, MailDetail, MailHistoryEntry, MailLink } from '../../bridge/index.js';
import { DataTable } from '../DataTable.js';
import { StatusTag } from '../StatusTag.js';
import { actionLabel } from '../OpBanner.js';
import { humanizeDocumentType } from '../documentType.js';
import { notify, notifyResult } from '../notify.js';
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

function rowBorder(index: number): CSSProperties {
  return { ...rowStyle, borderTop: index ? rowStyle.borderTop : 'none' };
}

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

/** 列表为空时的一行说明，保持和有内容时一样的外框。 */
function EmptyRow({ text }: { text: ReactNode }): JSX.Element {
  return (
    <div style={boxStyle}>
      <div style={{ ...rowBorder(0), color: DIM }}>{text}</div>
    </div>
  );
}

export function AttachmentList({ items, emptyText }: { items: MailAttachment[]; emptyText?: ReactNode }): JSX.Element {
  if (items.length === 0) return <EmptyRow text={emptyText ?? '这封邮件没有附件'} />;
  return (
    <div style={boxStyle}>
      {items.map((item, index) => (
        <div key={`${item.filename}-${index}`} style={rowBorder(index)}>
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

export function LinkList({ items, emptyText }: { items: MailLink[]; emptyText?: ReactNode }): JSX.Element {
  if (items.length === 0) return <EmptyRow text={emptyText ?? '正文里没有发票链接'} />;
  return (
    <div style={boxStyle}>
      {items.map((item, index) => {
        const { host, path } = splitLink(item.url);
        return (
          <Tooltip key={`${item.url}-${index}`} title={item.label || '点击复制链接'} placement="left">
            <div
              role="button"
              tabIndex={0}
              style={{ ...rowBorder(index), cursor: 'pointer' }}
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
  {
    title: '类型',
    key: 'type',
    width: 104,
    render: (_value: unknown, row: InvoiceRow) => humanizeDocumentType(row),
  },
  {
    title: '金额',
    dataIndex: 'amount',
    width: 96,
    align: 'right',
    render: (value: string) => <span className="mfh-num">{value || '—'}</span>,
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
      testId="table-mail-documents"
      rows={rows}
      columns={DOCUMENT_COLUMNS}
      rowKey={(row) => row.filename}
      searchKeys={[]}
      pagination={false}
      scrollX={false}
      onOpen={(row) => {
        void bridge.openFile(row.fileHandle || row.filePath).then((result) => {
          if (!result.ok) notifyResult(result, { success: '已打开文件', failure: '打不开这份文件' });
        });
      }}
      emptyText="这封邮件还没有归档文件"
    />
  );
}

/** 待确认原因：一句话说清为什么停在这里，再给一句下一步。 */
export function PendingReason({
  pending,
  fallbackTitle,
}: {
  pending: NonNullable<MailDetail['pending']>;
  fallbackTitle?: string;
}): JSX.Element {
  const detail = pending.userMessage || pending.nextStep;
  return (
    <Alert
      type="warning"
      showIcon
      message={pending.category || fallbackTitle || '需要人工确认'}
      description={
        detail ? (
          <>
            {pending.userMessage ? <div>{pending.userMessage}</div> : null}
            {pending.nextStep ? <div style={{ marginTop: 4 }}>{pending.nextStep}</div> : null}
          </>
        ) : undefined
      }
    />
  );
}

export function HistoryList({ items }: { items: MailHistoryEntry[] }): JSX.Element {
  if (items.length === 0) return <EmptyRow text="还没有处理记录" />;
  return (
    <div style={boxStyle}>
      {items.map((item, index) => (
        <div key={`${item.time}-${index}`} style={rowBorder(index)}>
          <span className="mfh-num" style={{ flex: 'none', fontSize: 12, color: DIM }}>
            {item.time}
          </span>
          <span style={{ flex: 'none' }}>{actionLabel(item.action)}</span>
          <StatusTag status={item.status} />
          <span style={{ ...clipStyle, color: DIM }} title={item.message}>
            {item.message}
          </span>
        </div>
      ))}
    </div>
  );
}
