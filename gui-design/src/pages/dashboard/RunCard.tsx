/** 「运行」卡片：时间范围、匹配范围、开始 / 停止、进度条。 */
import { Button, Card, Checkbox, DatePicker, Progress, Segmented, Space, Switch, Tooltip } from 'antd';
import type { Dayjs } from 'dayjs';
import { RANGE_OPTIONS, rangeFor, type RangePreset, type RunController } from './useRunController.js';

const { RangePicker } = DatePicker;

function RangeFields({ run }: { run: RunController }): JSX.Element {
  return (
    <div>
      <Segmented
        options={RANGE_OPTIONS}
        value={run.preset}
        disabled={run.busy}
        onChange={(value) => {
          const next = value as RangePreset;
          run.setPreset(next);
          run.setRange(rangeFor(next, run.range));
        }}
      />
      <div style={{ marginTop: 10 }}>
        <RangePicker
          value={run.range}
          allowClear={false}
          disabled={run.busy}
          style={{ width: '100%', maxWidth: 320 }}
          onChange={(value) => {
            const from = value?.[0];
            const to = value?.[1];
            if (!from || !to) return;
            run.setPreset('custom');
            run.setRange([from, to] as [Dayjs, Dayjs]);
          }}
        />
      </div>
    </div>
  );
}

function MatchFields({ run }: { run: RunController }): JSX.Element {
  return (
    <Space size={20} wrap>
      <Checkbox checked={run.matchSubject} disabled={run.busy} onChange={(e) => run.setMatchSubject(e.target.checked)}>
        匹配主题
      </Checkbox>
      <Checkbox checked={run.matchBody} disabled={run.busy} onChange={(e) => run.setMatchBody(e.target.checked)}>
        匹配正文
      </Checkbox>
      <Space size={8}>
        <Switch size="small" checked={run.dryRun} disabled={run.busy} onChange={run.setDryRun} />
        <span>试运行（不下载）</span>
      </Space>
    </Space>
  );
}

export function RunCard({ run }: { run: RunController }): JSX.Element {
  const stoppable = run.running?.kind === 'ocr';
  return (
    <Card title="运行" size="small">
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <RangeFields run={run} />
        <MatchFields run={run} />

        <Space>
          <Button type="primary" loading={run.busy} disabled={run.busy} onClick={() => void run.start()}>
            {run.dryRun ? '开始试运行' : '开始处理'}
          </Button>
          <Tooltip title={run.running && !stoppable ? '这一步不能中途停止' : ''}>
            <Button disabled={!stoppable} onClick={() => void run.stop()}>
              停止
            </Button>
          </Tooltip>
        </Space>

        <div>
          <Progress
            percent={run.percent}
            status={run.busy ? 'active' : run.percent === 100 ? 'success' : 'normal'}
            showInfo={false}
            size="small"
          />
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>{run.statusText}</div>
        </div>
      </Space>
    </Card>
  );
}
