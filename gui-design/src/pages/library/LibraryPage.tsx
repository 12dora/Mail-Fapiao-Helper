import { Empty } from 'antd';
import { PageHeader } from '../../components/index.js';

/**
 * 发票库页：识别结果列表、重复发票处理与文件打开。
 *
 * 占位实现。页面私有的状态、列定义、抽屉都放在本目录下；
 * 需要被别的页面复用的东西请提到 components/ 或 bridge/。
 */
export function LibraryPage(): JSX.Element {
  return (
    <>
      <PageHeader title="发票库" subtitle="已归档的发票、行程单与支撑材料" />
      <div className="mfh-scroll" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="页面建设中" />
      </div>
    </>
  );
}
