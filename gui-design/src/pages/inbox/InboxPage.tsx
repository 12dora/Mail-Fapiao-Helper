import { Empty } from 'antd';
import { PageHeader } from '../../components/index.js';

/**
 * 邮件记录页：列出抓到的邮件，支持打开原始邮件与查看产出的发票。
 *
 * 占位实现。页面私有的状态、列定义、抽屉都放在本目录下；
 * 需要被别的页面复用的东西请提到 components/ 或 bridge/。
 */
export function InboxPage(): JSX.Element {
  return (
    <>
      <PageHeader title="邮件记录" subtitle="已抓取的邮件与它们的处理结果" />
      <div className="mfh-scroll" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="页面建设中" />
      </div>
    </>
  );
}
