import { Alert, Button, Space, Tooltip } from 'antd';
import type { DescriptionsProps } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { bridge, primeSummary, reloadSummary } from '../../bridge/index.js';
import type { BaseResult, InboxRow, MailDetail } from '../../bridge/index.js';
import {
  AttachmentList,
  DetailDrawer,
  DocumentTable,
  HistoryList,
  LinkList,
  PendingReason,
  Section,
  StatusTag,
  notify,
  notifyResult,
  useBusy,
} from '../../components/index.js';
import { navigate } from '../../router.js';

/** 详情读不出来时的说明。code 之外的失败统一落到 fallback，不把状态码摆到界面上。 */
const FAILURE_TEXT: Record<string, { title: string; detail: string }> = {
  mail_not_found: { title: '找不到这封邮件', detail: '它可能已从数据目录移走。' },
  eml_unreadable: { title: '无法读取原始邮件', detail: '文件可能已损坏或被移走。' },
};

const FALLBACK_FAILURE = { title: '无法读取邮件详情', detail: '稍后重试，或重新获取这封邮件。' };

function failureText(result: BaseResult): { title: string; detail: string } {
  const preset = result.code ? FAILURE_TEXT[result.code] : undefined;
  if (preset) return preset;
  return {
    title: result.message?.trim() || FALLBACK_FAILURE.title,
    detail: result.detail?.trim() || FALLBACK_FAILURE.detail,
  };
}

function useMailDetail(row: InboxRow | null, open: boolean): {
  detail: MailDetail | null;
  failure: BaseResult | null;
  loading: boolean;
  refresh: () => void;
} {
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [failure, setFailure] = useState<BaseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const hash = row?.mailHash ?? '';

  useEffect(() => {
    if (!open || !hash) return;
    let alive = true;
    setLoading(true);
    setDetail(null);
    setFailure(null);
    bridge
      .mailDetail(hash)
      .then((result) => {
        if (!alive) return;
        if (result.ok && result.mail) setDetail(result.mail);
        else setFailure(result);
      })
      .catch((err: unknown) => {
        if (alive) setFailure({ ok: false, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, hash, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { detail, failure, loading, refresh };
}

function MailBody({ detail }: { detail: MailDetail }): JSX.Element {
  const empty =
    !detail.attachments.length &&
    !detail.links.length &&
    !detail.documents.length &&
    !detail.pending &&
    !detail.history.length;
  if (empty) return <p style={{ color: 'var(--mfh-text-dim)', margin: '18px 0 0' }}>这封邮件还没有处理结果</p>;
  return (
    <>
      {detail.pending ? (
        <Section title="待确认原因">
          <PendingReason pending={detail.pending} />
        </Section>
      ) : null}
      {detail.attachments.length ? (
        <Section title="附件" count={detail.attachments.length}>
          <AttachmentList items={detail.attachments} />
        </Section>
      ) : null}
      {detail.links.length ? (
        <Section title="链接" count={detail.links.length}>
          <LinkList items={detail.links} />
        </Section>
      ) : null}
      {detail.documents.length ? (
        <Section title="归档文件" count={detail.documents.length}>
          <DocumentTable rows={detail.documents} />
        </Section>
      ) : null}
      {detail.history.length ? (
        <Section title="处理记录">
          <HistoryList items={detail.history} />
        </Section>
      ) : null}
    </>
  );
}

async function openMailAt(hash: string, reveal: boolean): Promise<void> {
  const result = await bridge.openMail({ hash, reveal });
  if (!result.ok) {
    notifyResult(result, { success: '已打开', failure: reveal ? '无法显示邮件位置' : '无法打开原始邮件' });
    return;
  }
  if (!reveal && result.opened === 'folder') notify.info('已打开所在目录');
}

function DrawerActions({
  row,
  openable,
  isPending,
  onClose,
  onDone,
}: {
  row: InboxRow;
  openable: boolean;
  isPending: boolean;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { busy } = useBusy();
  const [working, setWorking] = useState(false);

  async function reprocess(): Promise<void> {
    setWorking(true);
    try {
      const result = await bridge.runPipeline({ onlyMail: row.mailHash });
      // 终态里带回的 summary 只够让计数立刻跟上，它是截断过的；
      // 无论有没有带回来都要按完整查询重新拉一次。
      primeSummary(result.summary);
      await reloadSummary();
      notifyResult(result, { success: '已重新处理', failure: '重新处理未完成' });
      onDone();
    } finally {
      setWorking(false);
    }
  }

  return (
    <Space>
      <Tooltip title={openable ? '' : '原始邮件不在本机'}>
        <Button disabled={!openable} onClick={() => void openMailAt(row.mailHash, true)}>
          显示文件
        </Button>
      </Tooltip>
      <Tooltip title={openable ? '' : '原始邮件不在本机'}>
        <Button disabled={!openable} onClick={() => void openMailAt(row.mailHash, false)}>
          打开邮件
        </Button>
      </Tooltip>
      {isPending ? (
        <Button
          onClick={() => {
            onClose();
            navigate('pending');
          }}
        >
          转到待确认
        </Button>
      ) : null}
      {isPending ? (
        <Button type="primary" loading={working} disabled={busy} onClick={() => void reprocess()}>
          重新处理
        </Button>
      ) : null}
    </Space>
  );
}

export interface MailDrawerProps {
  row: InboxRow | null;
  open: boolean;
  onClose: () => void;
}

/** 邮件详情抽屉：头部信息来自列表行，正文与操作以详情接口为准。 */
export function MailDrawer({ row, open, onClose }: MailDrawerProps): JSX.Element | null {
  const { detail, failure, loading, refresh } = useMailDetail(row, open);
  if (!row) return null;

  const status = detail?.status ?? row.status;
  const openable = detail ? detail.emlExists : row.mailOpenable;
  const items: DescriptionsProps['items'] = [
    { key: 'from', label: '发件人', children: detail?.from || row.from || '—' },
    { key: 'mailbox', label: '邮箱文件夹', children: detail?.mailbox || row.mailbox || '—' },
    { key: 'status', label: '状态', children: <StatusTag status={status} /> },
  ];

  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      testId="drawer-mail"
      loading={loading}
      title={row.subject || '无主题'}
      subtitle={detail?.date || row.date}
      items={items}
      actions={
        <DrawerActions
          row={row}
          openable={openable}
          isPending={status === 'pending'}
          onClose={onClose}
          onDone={refresh}
        />
      }
    >
      {failure ? (
        <Alert
          style={{ marginTop: 18 }}
          type="warning"
          showIcon
          message={failureText(failure).title}
          description={failureText(failure).detail}
        />
      ) : null}
      {detail ? <MailBody detail={detail} /> : null}
    </DetailDrawer>
  );
}
