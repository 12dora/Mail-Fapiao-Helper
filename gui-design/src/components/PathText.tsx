import { CopyOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { bridge } from '../bridge/index.js';
import { notify } from './notify.js';

export interface PathTextProps {
  path: string;
  /** 复制成功后的提示标题，默认「路径已复制」。 */
  copiedTitle?: string;
}

/**
 * 等宽显示一个路径或链接，右侧带复制按钮；过长时省略开头、保留结尾。
 *
 * `direction: rtl` 负责把省略号放到开头，`<bdi>` 负责把内容本身隔离出来——
 * 少了 bdi，双向算法会把 `~/…` 这类以中性字符开头的路径首尾对调，
 * 显示成 `…/config.json/~`。
 */
export function PathText({ path, copiedTitle = '路径已复制' }: PathTextProps): JSX.Element {
  if (!path) return <span className="mfh-path__text">—</span>;
  return (
    <span className="mfh-path">
      <Tooltip title={path}>
        <span className="mfh-path__text" style={{ direction: 'rtl' }}>
          <bdi>{path}</bdi>
        </span>
      </Tooltip>
      <Tooltip title="复制">
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          aria-label="复制"
          onClick={() => {
            void bridge.copyText(path).then((result) => {
              if (result.ok) notify.success(copiedTitle);
              else notify.error('复制失败', result.message);
            });
          }}
        />
      </Tooltip>
    </span>
  );
}
