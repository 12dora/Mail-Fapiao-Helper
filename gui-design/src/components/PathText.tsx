import { CopyOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { bridge } from '../bridge/index.js';
import { notify } from './notify.js';

export interface PathTextProps {
  path: string;
  /** 复制成功后的提示标题，默认「路径已复制」。 */
  copiedTitle?: string;
}

/** 等宽显示一个路径，右侧带复制按钮；路径过长时省略中间不省略结尾。 */
export function PathText({ path, copiedTitle = '路径已复制' }: PathTextProps): JSX.Element {
  if (!path) return <span className="mfh-path__text">—</span>;
  return (
    <span className="mfh-path">
      <Tooltip title={path}>
        <span className="mfh-path__text" dir="rtl">
          {path}
        </span>
      </Tooltip>
      <Tooltip title="复制路径">
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          aria-label="复制路径"
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
