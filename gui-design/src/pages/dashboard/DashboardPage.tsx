/**
 * 首页：一次运行的入口。
 *
 * 上半屏是四个计数和运行区，下半屏是本次结果与最近运行。
 * 运行本身的状态都在 useRunController 里，这里只排版。
 */
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Space } from 'antd';
import { bridge, useSummary } from '../../bridge/index.js';
import type { AppSummary } from '../../bridge/index.js';
import { LogConsole, PageHeader, StatCard, notifyResult } from '../../components/index.js';
import { RunCard } from './RunCard.js';
import { BatchCard, HistoryCard } from './tables.js';
import { useRunController } from './useRunController.js';

function openArchive(): void {
  void bridge.openPath({ location: 'invoices' }).then((result) => {
    if (!result.ok) notifyResult(result, { success: '已打开', failure: '打开失败' });
  });
}

function StatsRow({ summary, loading }: { summary: AppSummary | null; loading: boolean }): JSX.Element {
  const inbox = summary?.inbox;
  const library = summary?.library;
  const pending = summary?.pending;
  return (
    <div className="mfh-stats">
      <StatCard
        label="邮件"
        value={inbox?.total ?? 0}
        hint={`含附件 ${inbox?.withAttachment ?? 0} 封`}
        loading={loading}
      />
      <StatCard
        label="发票"
        value={library?.total ?? 0}
        hint={`行程单 ${library?.itinerary ?? 0} 份`}
        loading={loading}
      />
      <StatCard
        label="待确认"
        value={pending?.total ?? 0}
        hint={pending?.total ? '需要人工处理' : '没有待处理项'}
        loading={loading}
      />
      <StatCard
        label="已识别"
        value={library?.recognized ?? 0}
        hint={`待补充 ${library?.pending ?? 0} 份`}
        loading={loading}
      />
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const { data: summary, loading, reload } = useSummary();
  const run = useRunController();
  const firstLoad = loading && !summary;

  return (
    <>
      <PageHeader
        title="开始处理"
        subtitle={
          summary
            ? `已保存 ${summary.inbox.total} 封邮件，归档 ${summary.library.total} 份文件`
            : '正在读取本机数据'
        }
        actions={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
              刷新
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={openArchive}>
              打开归档目录
            </Button>
          </Space>
        }
      />

      <div className="mfh-scroll">
        <StatsRow summary={summary} loading={firstLoad} />

        <div className="mfh-run-grid">
          <div className="mfh-fill" data-testid="run-card">
            <RunCard run={run} />
          </div>
          <div className="mfh-fill mfh-fill--float" data-testid="log-card">
            <Card title="运行日志" size="small">
              <LogConsole lines={run.logLines} placeholder="点击「开始处理」后，这里显示每一步的结果" />
            </Card>
          </div>
        </div>

        <BatchCard rows={run.batch} />
        <HistoryCard summary={summary} loading={firstLoad} />
      </div>
    </>
  );
}
