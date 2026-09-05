/**
 * 待确认行的详情抽屉。
 *
 * 第一屏必须回答「这封邮件为什么在这里」，再给出可以立刻做的动作，
 * 最后才是附件 / 链接 / 归档文件这些证据。
 *
 * 证据区与邮件记录页共用 components/mail 的分区，两边看到的是同一封邮件。
 */
import { Alert, Button, Space } from 'antd';
import type { DescriptionsProps } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../../bridge/index.js';
import type { MailDetail } from '../../bridge/index.js';
import {
  AttachmentList,
  DetailDrawer,
  DocumentTable,
  HistoryList,
  LinkList,
  PendingReason,
  Section,
} from '../../components/index.js';
import type { PendingActions, PendingQueueRow } from './usePendingActions.js';

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

/** 证据区：附件与链接常驻（空也要说明），归档文件与处理记录有内容才显示。 */
function MailSections({ detail }: { detail: MailDetail | null }): JSX.Element {
  const attachments = detail?.attachments ?? [];
  const links = detail?.links ?? [];
  const documents = detail?.documents ?? [];
  const history = detail?.history ?? [];
  return (
    <>
      <Section title="附件" count={attachments.length}>
        <AttachmentList items={attachments} />
      </Section>
      <Section title="链接" count={links.length}>
        <LinkList items={links} />
      </Section>
      {documents.length > 0 ? (
        <Section title="归档文件" count={documents.length}>
          <DocumentTable rows={documents} />
        </Section>
      ) : null}
      {history.length > 0 ? (
        <Section title="处理记录">
          <HistoryList items={history} />
        </Section>
      ) : null}
    </>
  );
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
    reason: '',
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
      testId="drawer-pending"
      loading={loading}
      title={row.subject || '无主题'}
      subtitle={`${row.date} · ${row.from}`}
      actions={<DrawerActions row={row} actions={actions} />}
      before={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 14 }}>
          {error ? (
            <Alert
              type="error"
              showIcon
              message={error}
              action={
                <Button size="small" type="text" onClick={reload}>
                  重新读取
                </Button>
              }
            />
          ) : null}
          <PendingReason pending={reason} fallbackTitle={row.groupTitle} />
        </div>
      }
      items={items}
    >
      <MailSections detail={detail} />
    </DetailDrawer>
  );
}
