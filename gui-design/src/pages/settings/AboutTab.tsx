/**
 * 关于标签页：版本、数据位置、归档恢复、开发者重置。
 */
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Descriptions, Space, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { bridge, reloadSummary, useAppInfo } from '../../bridge/index.js';
import type { AppInfo, ArchiveJournalStatus } from '../../bridge/index.js';
import { notify, notifyResult, useBusy } from '../../components/index.js';
import { PathLine, openLocation } from './fields.js';

const REPO_URL = 'https://github.com/12dora/Mail-Fapiao-Helper';
const ISSUE_URL = 'https://github.com/12dora/Mail-Fapiao-Helper/issues';

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

const LABEL_STYLE = { width: 96, color: 'var(--mfh-text-dim)' };

function platformText(info: AppInfo): string {
  const name = PLATFORM_NAMES[info.platform] ?? info.platform;
  return info.arch ? `${name} · ${info.arch}` : name;
}

/** 打包过的正式版不显示破坏性的开发者操作。 */
function showsDeveloperTools(info: AppInfo | null): boolean {
  if (!info) return false;
  if (!info.packaged) return true;
  return !/正式版|release/i.test(info.channel);
}

function journalText(status: ArchiveJournalStatus | null): string {
  if (!status) return '正在读取';
  if (status.status === 'clear') return '归档记录完整，无需处理。';
  if (status.status === 'residual') return `有 ${status.residualCount} 条上次中断留下的记录。`;
  return '归档记录无法读取，归档已暂停。';
}

// ---------------------------------------------------------------------------
// 分区
// ---------------------------------------------------------------------------

function AppCard({ configPath, info }: { configPath: string; info: AppInfo | null }): JSX.Element {
  return (
    <Card size="small" title="应用">
      <Descriptions column={1} size="small" colon={false} labelStyle={LABEL_STYLE}>
        <Descriptions.Item label="名称">发票助手</Descriptions.Item>
        <Descriptions.Item label="版本">{info?.version ?? '读取中'}</Descriptions.Item>
        <Descriptions.Item label="渠道">{info?.channel ?? '读取中'}</Descriptions.Item>
        <Descriptions.Item label="运行环境">
          {info ? `${platformText(info)} · Electron ${info.electron}` : '读取中'}
        </Descriptions.Item>
        <Descriptions.Item label="配置文件">
          <PathLine path={configPath} />
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function DataCard({ dataDir }: { dataDir: string }): JSX.Element {
  return (
    <Card size="small" title="数据">
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <PathLine path={dataDir} />
        <Space size={8} wrap>
          <Button icon={<FolderOpenOutlined />} onClick={() => openLocation('dataDir')}>
            打开数据目录
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => openLocation('invoices')}>
            打开发票目录
          </Button>
        </Space>
      </Space>
    </Card>
  );
}

function JournalCard(): JSX.Element {
  const { busy } = useBusy();
  const { modal } = AntApp.useApp();
  const [status, setStatus] = useState<ArchiveJournalStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setStatus(await bridge.archiveJournalStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function quarantine(): void {
    modal.confirm({
      title: '隔离残留记录',
      content: '残留记录会移到备份文件，归档随后继续。此操作不可撤销。',
      okText: '隔离',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setWorking(true);
        try {
          const result = await bridge.archiveJournalQuarantine();
          notifyResult(result, { success: '已隔离残留记录', failure: '隔离失败' });
          await refresh();
        } finally {
          setWorking(false);
        }
      },
    });
  }

  const blocked = status?.status === 'unreadable' || status?.blocked === true;
  return (
    <Card
      size="small"
      title="归档恢复"
      extra={
        <Button type="text" size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {blocked ? (
          <Alert type="warning" showIcon message="归档已暂停" description="隔离残留记录后才能继续归档。" />
        ) : null}
        <span>{journalText(status)}</span>
        <Button danger disabled={status?.canQuarantine !== true || busy || working} onClick={quarantine}>
          隔离残留记录
        </Button>
      </Space>
    </Card>
  );
}

function LinksCard(): JSX.Element {
  return (
    <Card size="small" title="项目">
      <Descriptions column={1} size="small" colon={false} labelStyle={LABEL_STYLE}>
        <Descriptions.Item label="项目地址">
          <PathLine path={REPO_URL} copiedTitle="链接已复制" />
        </Descriptions.Item>
        <Descriptions.Item label="反馈问题">
          <PathLine path={ISSUE_URL} copiedTitle="链接已复制" />
        </Descriptions.Item>
      </Descriptions>
      <Typography.Text type="secondary">应用不会打开浏览器，复制链接后在浏览器中打开。</Typography.Text>
    </Card>
  );
}

function DeveloperCard(): JSX.Element {
  const { busy } = useBusy();
  const { modal } = AntApp.useApp();
  const [working, setWorking] = useState(false);

  async function run(): Promise<void> {
    setWorking(true);
    try {
      const result = await bridge.developerReset();
      notifyResult(result, { success: '已重置应用数据', failure: '重置失败' });
      if (result.skippedExternal?.length) {
        notify.warning('部分目录未删除', '自定义位置的目录需要手动清理。');
      }
      await reloadSummary();
    } finally {
      setWorking(false);
    }
  }

  // 两道确认：第一道说清会删什么，第二道说清不可恢复。
  function confirm(): void {
    modal.confirm({
      title: '重置应用数据',
      content: '已保存的邮件、发票、待确认队列和台账都会被删除，邮箱与保存设置保留。',
      okText: '继续',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        new Promise<void>((resolve) => {
          modal.confirm({
            title: '确认删除本机数据',
            content: '删除后无法恢复，需要重新获取邮件。',
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            afterClose: resolve,
            onOk: run,
          });
        }),
    });
  }

  return (
    <Card size="small" title="开发者">
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <span>清空本机已保存的邮件、发票与台账，邮箱与保存设置保留。</span>
        <Button danger disabled={busy || working} onClick={confirm}>
          重置应用数据
        </Button>
      </Space>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export interface AboutTabProps {
  configPath: string;
  dataDir: string;
}

export function AboutTab({ configPath, dataDir }: AboutTabProps): JSX.Element {
  const { data: info } = useAppInfo();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <AppCard configPath={configPath} info={info} />
      <DataCard dataDir={dataDir} />
      <JournalCard />
      <LinksCard />
      {showsDeveloperTools(info) ? <DeveloperCard /> : null}
    </Space>
  );
}
