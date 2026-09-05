import { Empty } from 'antd';
import { PageHeader } from '../../components/index.js';

/**
 * 设置页：邮箱 / 保存与整理 / 识别 / 关于 四个标签页。
 *
 * 占位实现。页面私有的状态、列定义、抽屉都放在本目录下；
 * 需要被别的页面复用的东西请提到 components/ 或 bridge/。
 */
export function SettingsPage(): JSX.Element {
  return (
    <>
      <PageHeader title="设置" subtitle="邮箱、保存与整理、识别、关于" />
      <div className="mfh-scroll" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="页面建设中" />
      </div>
    </>
  );
}
