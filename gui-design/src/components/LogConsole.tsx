import { CopyOutlined, VerticalAlignBottomOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/index.js';
import type { LogLine } from '../bridge/index.js';
import { notify } from './notify.js';

export interface LogConsoleProps {
  lines: LogLine[];
  /** 没有日志时的一句话说明，告诉用户接下来做什么。 */
  placeholder?: string;
}

/**
 * 运行日志面板。
 *
 * 高度完全由父容器决定（flex:1 + min-height:0），不写死像素——旧界面把它钉死在
 * 156px，右栏底部永远空一大块。父级只要是 `.mfh-fill` 里的卡片就自动填满。
 */
export function LogConsole({ lines, placeholder = '运行日志会显示在这里。' }: LogConsoleProps): JSX.Element {
  const [follow, setFollow] = useState(true);
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!follow) return;
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  // 用户手动往上翻就停止跟随，滚回底部再恢复。
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setFollow(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  async function copyAll(): Promise<void> {
    if (!lines.length) {
      notify.info('没有可复制的日志');
      return;
    }
    const text = lines.map((line) => `${line.time} ${line.text}`).join('\n');
    const result = await bridge.copyText(text);
    if (result.ok) notify.success('日志已复制');
    else notify.error('复制失败', result.message);
  }

  return (
    <div className="mfh-log">
      <div className="mfh-log__body" ref={body} role="log" aria-live="polite">
        {lines.length === 0 ? (
          <div className="mfh-log__empty">{placeholder}</div>
        ) : (
          lines.map((line, index) => (
            <div className="mfh-log__line" key={`${line.id}-${index}`}>
              <span className="mfh-log__time">{line.time}</span>
              <span className={`mfh-log__text mfh-log__text--${line.kind}`}>{line.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="mfh-log__bar">
        <span>{lines.length ? `${lines.length} 行` : '等待运行'}</span>
        <span>
          <Tooltip title={follow ? '已跟随最新一行' : '跟随最新一行'}>
            <Button
              type="text"
              size="small"
              icon={<VerticalAlignBottomOutlined />}
              onClick={() => {
                setFollow(true);
                const el = body.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              style={{ opacity: follow ? 1 : 0.55 }}
              aria-label="跟随最新一行"
            />
          </Tooltip>
          <Tooltip title="复制日志">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => void copyAll()} aria-label="复制日志" />
          </Tooltip>
        </span>
      </div>
    </div>
  );
}
