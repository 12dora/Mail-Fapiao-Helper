import { Descriptions, Drawer, Space, Spin } from 'antd';
import type { DescriptionsProps } from 'antd';
import type { ReactNode } from 'react';

export interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** 标题下的一行副标题，通常是主键或时间。 */
  subtitle?: ReactNode;
  loading?: boolean;
  /** 键值区之前的内容：警示条、原因说明这一类必须先看到的东西。 */
  before?: ReactNode;
  /** 主体的键值区；不需要时留空，直接用 children。 */
  items?: DescriptionsProps['items'];
  /** 键值区之后的自定义内容（子表、重复列表等）。 */
  children?: ReactNode;
  /** 底部操作按钮，从左到右按重要性递增。 */
  actions?: ReactNode;
  width?: number;
}

/** 行详情统一用右侧抽屉，宽 560，不用弹窗——弹窗会挡住用户刚点的那一行。 */
export function DetailDrawer({
  open,
  onClose,
  title,
  subtitle,
  loading,
  before,
  items,
  children,
  actions,
  width = 560,
}: DetailDrawerProps): JSX.Element {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={width}
      destroyOnClose
      title={
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>{subtitle}</div> : null}
        </div>
      }
      footer={actions ? <Space style={{ width: '100%', justifyContent: 'flex-end' }}>{actions}</Space> : null}
      styles={{ body: { paddingTop: 16 } }}
    >
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
          <Spin />
        </div>
      ) : (
        <>
          {before}
          {items?.length ? <Descriptions column={1} size="small" colon={false} items={items} /> : null}
          {children}
        </>
      )}
    </Drawer>
  );
}
