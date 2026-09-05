import { LoadingOutlined } from '@ant-design/icons';
import { Alert } from 'antd';
import { useEffect, useState } from 'react';
import { useOpState } from '../bridge/index.js';
import type { OpKind, RunningOp } from '../bridge/index.js';

const OP_LABELS: Record<OpKind, string> = {
  fetch: '获取邮件',
  pipeline: '获取发票文件',
  ocr: '识别发票',
  organize: '整理归档',
};

export function opLabel(kind: OpKind | undefined): string {
  return kind ? OP_LABELS[kind] ?? '处理' : '处理';
}

function elapsedText(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export interface BusyState {
  /** 有互斥任务在跑：所有会写盘的按钮都要 disabled。 */
  busy: boolean;
  running: RunningOp | null;
  /** 当前任务的中文名，空闲时为空串。 */
  label: string;
}

/**
 * 页面判断「现在能不能动手」的唯一入口。
 * 长任务在主进程是互斥的，抢跑只会拿到一条 code=busy 的失败回执，
 * 所以按钮直接置灰比让用户点了再报错好。
 */
export function useBusy(): BusyState {
  const { running } = useOpState();
  return { busy: Boolean(running), running, label: running ? opLabel(running.kind) : '' };
}

/** 顶部运行提示条：任务名 + 已用时间。空闲时不占位。 */
export function OpBanner(): JSX.Element | null {
  const { running } = useOpState();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!running) return null;
  return (
    <Alert
      banner
      type="info"
      icon={<LoadingOutlined />}
      showIcon
      message={
        <span>
          正在{opLabel(running.kind)}
          <span className="mfh-num" style={{ marginInlineStart: 10, opacity: 0.7 }}>
            已用 {elapsedText(running.startedAt, now)}
          </span>
        </span>
      }
      style={{ flex: 'none' }}
    />
  );
}
