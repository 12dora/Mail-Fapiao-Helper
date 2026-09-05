/**
 * 待确认行的详情抽屉。
 *
 * 第一屏必须回答「这封邮件为什么在这里」，再给出可以立刻做的动作，
 * 最后才是附件 / 链接 / 归档文件这些证据。
 *
 * 注意：邮件记录页也在做一个结构相近的抽屉，这份实现先留在本目录下，
 * 等两边都定型后再提到 components/。
 */
import { Alert, Button, Descriptions, Space } from 'antd';
import type { DescriptionsProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../../bridge/index.js';
import type { InvoiceRow, MailAttachment, MailDetail, MailLink } from '../../bridge/index.js';
import { DataTable, DetailDrawer, StatusTag, notify } from '../../components/index.js';
import type { PendingActions, PendingQueueRow } from './usePendingActions.js';

function fileSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const ATTACHMENT_COLUMNS: ColumnsType<MailAttachment> = [
  { title: '文件名', dataIndex: 'filename', ellipsis: true },
  { title: '大小', dataIndex: 'size', width: 88, align: 'right', render: (value: number) => fileSize(value) },
];

const LINK_COLUMNS: ColumnsType<MailLink> = [
  { title: '说明', dataIndex: 'label', width: 128, ellipsis: true, render: (value: string) => value || '—' },
  {
    title: '链接',
    dataIndex: 'url',
    ellipsis: true,
    render: (value: string) => <span style={{ fontFamily: 'var(--mfh-mono)', fontSize: 12 }}>{value}</span>,
  },
];

const DOCUMENT_COLUMNS: ColumnsType<InvoiceRow> = [
  { title: '文件名', dataIndex: 'filename', ellipsis: true },
  { title: '状态', dataIndex: 'status', width: 92, render: (value: string) => <StatusTag status={value} /> },
  {
    title: '金额',
    dataIndex: 'amount',
    width: 96,
    align: 'right',
    render: (value: string) => <span className="mfh-num">{value || '—'}</span>,
  },
];

function Section({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </section>
  );
}

function copyLink(url: string): void {
  void bridge.copyText(url).then((result) => {
    if (result.ok) notify.success('链接已复制');
    else notify.error('复制失败', result.message);
  });
}

/** 证据区：附件与链接常驻（空也要说明），归档文件只有真的产出过才显示。 */
function MailSections({ detail }: { detail: MailDetail | null }): JSX.Element {
  const attachments = detail?.attachments ?? [];
  const links = detail?.links ?? [];
  const documents = detail?.documents ?? [];
  return (
    <>
      <Section title={`附件 ${attachments.length}`}>
        <DataTable<MailAttachment>
          rows={attachments}
          columns={ATTACHMENT_COLUMNS}
          rowKey={(item) => item.filename}
          searchKeys={[]}
          pagination={false}
          emptyText="这封邮件没有附件"
        />
      </Section>

      <Section title={`链接 ${links.length}`}>
        <DataTable<MailLink>
          rows={links}
          columns={LINK_COLUMNS}
          rowKey={(item) => item.url}
          searchKeys={[]}
          pagination={false}
          emptyText="正文里没有发票链接"
          onOpen={(item) => copyLink(item.url)}
        />
      </Section>

      {documents.length > 0 ? (
        <Section title={`归档文件 ${documents.length}`}>
          <DataTable<InvoiceRow>
            rows={documents}
            columns={DOCUMENT_COLUMNS}
            rowKey={(item) => item.filename}
            searchKeys={[]}
            pagination={false}
            emptyText="还没有归档文件"
            onOpen={(item) => void bridge.revealFile(item.fileHandle)}
          />
        </Section>
      ) : null}
    </>
  );
}

function DrawerActions({ row, actions }: { row: PendingQueueRow; actions: PendingActions }): JSX.Element {
  return (
    <Space>
      <Button danger disabled={actions.disabled} onClick={() => actions.ignore(row)}>
        忽略
      </Button>
      <Button disabled={actions.disabled} onClick={() => void actions.manualArchive(row)}>
        手动归档
      </Button>
      <Button onClick={() => void actions.revealMail(row)}>显示文件</Button>
      <Button disabled={actions.disabled} loading={actions.working} onClick={() => void actions.retry(row)}>
        重试
      </Button>
      <Button type="primary" onClick={() => void actions.openMail(row)}>
        打开邮件
      </Button>
    </Space>
  );
}

interface DetailState {
  detail: MailDetail | null;
  loading: boolean;
  error: string;
}

const IDLE: DetailState = { detail: null, loading: false, error: '' };

/** 按 hash 拉 mailDetail；连续点行时只认最后一次请求的结果。 */
function useMailDetail(hash: string): DetailState & { reload: () => void } {
  const [state, setState] = useState<DetailState>(IDLE);
  const ticket = useRef(0);

  const load = useCallback((target: string) => {
    const mine = ++ticket.current;
    setState({ detail: null, loading: true, error: '' });
    void bridge.mailDetail(target).then((result) => {
      if (mine !== ticket.current) return;
      setState({
        detail: result.mail ?? null,
        loading: false,
        error: result.ok ? '' : result.message?.trim() || '读取邮件失败',
      });
    });
  }, []);

  useEffect(() => {
    if (!hash) {
      ticket.current++;
      setState(IDLE);
      return;
    }
    load(hash);
  }, [hash, load]);

  return { ...state, reload: () => hash && load(hash) };
}

export interface PendingDetailDrawerProps {
  row: PendingQueueRow | null;
  onClose: () => void;
  actions: PendingActions;
}

export function PendingDetailDrawer({ row, onClose, actions }: PendingDetailDrawerProps): JSX.Element {
  const { detail, loading, error, reload } = useMailDetail(row?.hash ?? '');

  if (!row) return <DetailDrawer open={false} onClose={onClose} title="" />;

  // 队列里的分组文案永远可用；mailDetail 拿到更具体的就覆盖它。
  const reason = detail?.pending ?? {
    category: row.category || row.groupTitle,
    userMessage: row.userMessage || row.groupMessage,
    nextStep: row.nextStep || row.groupNextStep,
  };

  const items: DescriptionsProps['items'] = [
    { key: 'date', label: '时间', children: <span className="mfh-num">{row.date || '—'}</span> },
    { key: 'from', label: '发件人', children: row.from || '—' },
    { key: 'eml', label: '原始邮件', children: detail ? (detail.emlExists ? '已保存' : '未保存') : '—' },
  ];

  return (
    <DetailDrawer
      open
      onClose={onClose}
      loading={loading}
      title={row.subject || '（无主题）'}
      subtitle={`${row.date} · ${row.from}`}
      actions={<DrawerActions row={row} actions={actions} />}
    >
      <>
        {error ? (
          <Alert
            type="error"
            showIcon
            message={error}
            style={{ marginBottom: 14 }}
            action={
              <Button size="small" type="text" onClick={reload}>
                重新读取
              </Button>
            }
          />
        ) : null}
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={reason.category || row.groupTitle}
          description={
            <>
              <div>{reason.userMessage}</div>
              {reason.nextStep ? <div style={{ marginTop: 4 }}>{reason.nextStep}</div> : null}
            </>
          }
        />
        <Descriptions column={1} size="small" colon={false} items={items} />
        <MailSections detail={detail} />
      </>
    </DetailDrawer>
  );
}
