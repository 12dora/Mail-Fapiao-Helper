import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, DatePicker, Progress, Segmented, Space, Switch, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { bridge, primeSummary, reloadSummary, useProgress, useSummary } from '../../bridge/index.js';
import type { BatchRow, LogLine, RunHistoryEntry } from '../../bridge/index.js';
import {
  DataTable,
  LogConsole,
  PageHeader,
  StatCard,
  StatusTag,
  notify,
  notifyResult,
  useBusy,
} from '../../components/index.js';

const { RangePicker } = DatePicker;

type RangePreset = '7d' | '30d' | 'month' | 'custom';

const RANGE_OPTIONS = [
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '本月', value: 'month' },
  { label: '自定义', value: 'custom' },
];

function rangeFor(preset: RangePreset, current: [Dayjs, Dayjs]): [Dayjs, Dayjs] {
  const today = dayjs();
  if (preset === '7d') return [today.subtract(6, 'day'), today];
  if (preset === '30d') return [today.subtract(29, 'day'), today];
  if (preset === 'month') return [today.startOf('month'), today];
  return current;
}

/** 进度事件的 phase 只在日志里有意义，进度条旁边显示一句人话。 */
const PHASE_TEXT: Record<string, string> = {
  connect: '连接邮箱',
  search: '搜索邮件',
  download: '保存邮件',
  scan: '扫描邮件',
  queue: '准备识别队列',
  recognize: '识别发票',
  done: '已完成',
};

function formatDuration(ms: number): string {
  if (!ms) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const BATCH_COLUMNS: ColumnsType<BatchRow> = [
  { title: '时间', dataIndex: 'date', width: 150 },
  { title: '发件人', dataIndex: 'from', width: 220, ellipsis: true },
  { title: '主题', dataIndex: 'subject', ellipsis: true },
  {
    title: '附件',
    dataIndex: 'hasAttachment',
    width: 80,
    render: (value: boolean) => (value ? '有' : '—'),
  },
];

const HISTORY_COLUMNS: ColumnsType<RunHistoryEntry> = [
  { title: '时间', dataIndex: 'time', width: 150 },
  { title: '操作', dataIndex: 'title', width: 140 },
  {
    title: '状态',
    dataIndex: 'status',
    width: 100,
    render: (value: RunHistoryEntry['status']) => <StatusTag status={value} />,
  },
  { title: '结果', dataIndex: 'message', ellipsis: true },
  {
    title: '用时',
    dataIndex: 'durationMs',
    width: 100,
    align: 'right',
    render: (value: number) => formatDuration(value),
  },
];

export function DashboardPage(): JSX.Element {
  const { data: summary, loading, reload } = useSummary();
  const { busy, running } = useBusy();

  const fetchProgress = useProgress('fetch');
  const fileProgress = useProgress('files');
  const ocrProgress = useProgress('ocr');

  const [preset, setPreset] = useState<RangePreset>('30d');
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => rangeFor('30d', [dayjs(), dayjs()]));
  const [matchSubject, setMatchSubject] = useState(true);
  const [matchBody, setMatchBody] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [batch, setBatch] = useState<BatchRow[]>([]);
  const [notes, setNotes] = useState<LogLine[]>([]);

  function note(text: string, kind: LogLine['kind'] = 'info'): void {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
    setNotes((prev) => [...prev, { id: prev.length + 1, time, text, kind }]);
  }

  /** 三路进度事件加本地提示，按时间戳合并成一条日志流。 */
  const logLines = useMemo(() => {
    const merged = [...notes, ...fetchProgress.lines, ...fileProgress.lines, ...ocrProgress.lines];
    return merged.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }, [notes, fetchProgress.lines, fileProgress.lines, ocrProgress.lines]);

  const activeProgress = running?.kind === 'ocr' ? ocrProgress : running?.kind === 'pipeline' ? fileProgress : fetchProgress;
  const phase = PHASE_TEXT[activeProgress.phase] ?? '';

  async function start(): Promise<void> {
    if (!matchSubject && !matchBody) {
      notify.warning('至少选择一个匹配范围', '主题和正文需要勾选其中一项。');
      return;
    }
    const payload = {
      from: range[0].format('YYYY-MM-DD'),
      to: range[1].format('YYYY-MM-DD'),
      matchSubject,
      matchBody,
      dryRun,
    };

    note(dryRun ? '开始试运行' : '开始处理');
    const fetched = await bridge.startFetch(payload);
    setBatch(fetched.batch?.rows ?? []);
    primeSummary(fetched.summary);
    if (!fetched.ok) {
      notifyResult(fetched, { success: '已完成', failure: '获取邮件未完成' });
      return;
    }
    if (dryRun) {
      notify.success('试运行完成', fetched.message ?? '未下载任何邮件。');
      return;
    }

    const files = await bridge.runPipeline({});
    primeSummary(files.summary);
    if (!files.ok) {
      notifyResult(files, { success: '已完成', failure: '获取发票文件未完成' });
      await reloadSummary();
      return;
    }

    const ocr = await bridge.runOcr({});
    primeSummary(ocr.summary);
    if (ocr.code === 'ocr_no_work') {
      note('没有待识别的文件', 'info');
    }
    notifyResult(ocr.ok ? files : ocr, { success: '处理完成', failure: '识别未完成' });
    await reloadSummary();
  }

  async function stop(): Promise<void> {
    const result = await bridge.stopOcr();
    notifyResult(result, { success: '正在停止', failure: '停止失败' });
  }

  const inbox = summary?.inbox;
  const library = summary?.library;
  const pending = summary?.pending;

  return (
    <>
      <PageHeader
        title="开始处理"
        subtitle={summary ? `已保存 ${inbox?.total ?? 0} 封邮件，归档 ${library?.total ?? 0} 份文件` : '正在读取本机数据'}
        actions={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
              刷新
            </Button>
            <Button
              icon={<FolderOpenOutlined />}
              onClick={() => {
                void bridge.openPath({ location: 'invoices' }).then((result) => {
                  if (!result.ok) notifyResult(result, { success: '已打开', failure: '打开失败' });
                });
              }}
            >
              打开归档目录
            </Button>
          </Space>
        }
      />

      <div className="mfh-scroll">
        <div className="mfh-stats">
          <StatCard label="邮件" value={inbox?.total ?? 0} hint={`含附件 ${inbox?.withAttachment ?? 0} 封`} loading={loading && !summary} />
          <StatCard label="发票" value={library?.total ?? 0} hint={`行程单 ${library?.itinerary ?? 0} 份`} loading={loading && !summary} />
          <StatCard label="待确认" value={pending?.total ?? 0} hint={pending?.total ? '需要人工处理' : '没有待处理项'} loading={loading && !summary} />
          <StatCard
            label="已识别"
            value={library?.recognized ?? 0}
            hint={`待补充 ${library?.pending ?? 0} 份`}
            loading={loading && !summary}
          />
        </div>

        <div className="mfh-run-grid">
          <div className="mfh-fill">
            <Card title="运行" size="small">
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <div>
                  <Segmented
                    options={RANGE_OPTIONS}
                    value={preset}
                    disabled={busy}
                    onChange={(value) => {
                      const next = value as RangePreset;
                      setPreset(next);
                      setRange((current) => rangeFor(next, current));
                    }}
                  />
                  <div style={{ marginTop: 10 }}>
                    <RangePicker
                      value={range}
                      allowClear={false}
                      disabled={busy}
                      style={{ width: '100%', maxWidth: 320 }}
                      onChange={(value) => {
                        if (!value?.[0] || !value[1]) return;
                        setPreset('custom');
                        setRange([value[0], value[1]]);
                      }}
                    />
                  </div>
                </div>

                <Space size={20} wrap>
                  <Checkbox checked={matchSubject} disabled={busy} onChange={(e) => setMatchSubject(e.target.checked)}>
                    匹配主题
                  </Checkbox>
                  <Checkbox checked={matchBody} disabled={busy} onChange={(e) => setMatchBody(e.target.checked)}>
                    匹配正文
                  </Checkbox>
                  <Space size={8}>
                    <Switch size="small" checked={dryRun} disabled={busy} onChange={setDryRun} />
                    <span>试运行（不下载）</span>
                  </Space>
                </Space>

                <Space>
                  <Button type="primary" loading={busy} disabled={busy} onClick={() => void start()}>
                    {dryRun ? '开始试运行' : '开始处理'}
                  </Button>
                  <Tooltip title={running && running.kind !== 'ocr' ? '这一步不能中途停止' : ''}>
                    <Button disabled={running?.kind !== 'ocr'} onClick={() => void stop()}>
                      停止
                    </Button>
                  </Tooltip>
                </Space>

                <div>
                  <Progress
                    percent={activeProgress.percent}
                    status={busy ? 'active' : activeProgress.percent === 100 ? 'success' : 'normal'}
                    showInfo={false}
                    size="small"
                  />
                  <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
                    {busy ? `${phase || '处理中'}…` : activeProgress.latest?.message || '尚未运行'}
                  </div>
                </div>
              </Space>
            </Card>
          </div>

          <div className="mfh-fill">
            <Card title="运行日志" size="small">
              <LogConsole lines={logLines} placeholder="点击「开始处理」后，这里显示每一步的结果" />
            </Card>
          </div>
        </div>

        <Card title="本次结果" size="small">
          <DataTable<BatchRow>
            rows={batch}
            columns={BATCH_COLUMNS}
            rowKey={(row) => row.messageId}
            searchKeys={['from', 'subject']}
            searchPlaceholder="搜索发件人或主题"
            defaultPageSize={20}
            emptyText="本次运行还没有新邮件"
          />
        </Card>

        <Card title="最近运行" size="small">
          <DataTable<RunHistoryEntry>
            rows={summary?.history ?? []}
            columns={HISTORY_COLUMNS}
            rowKey={(row) => row.id}
            searchKeys={['title', 'message']}
            searchPlaceholder="搜索操作或结果"
            defaultPageSize={20}
            loading={loading && !summary}
            emptyText="还没有运行记录"
          />
        </Card>
      </div>
    </>
  );
}
