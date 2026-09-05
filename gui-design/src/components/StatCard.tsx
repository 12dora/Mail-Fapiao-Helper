import { Skeleton } from 'antd';
import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: number | string;
  /** 一行补充说明，例如「其中 12 份待补充」。留空会占位保持一行高度。 */
  hint?: ReactNode;
  loading?: boolean;
  onClick?: () => void;
}

/** 顶部统计卡。没有阴影、没有图标，靠数字本身撑起层级。 */
export function StatCard({ label, value, hint, loading, onClick }: StatCardProps): JSX.Element {
  const clickable = typeof onClick === 'function';
  return (
    <div
      className="mfh-stat"
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={clickable ? { cursor: 'pointer' } : undefined}
    >
      <span className="mfh-stat__label">{label}</span>
      {loading ? (
        <Skeleton.Input active size="small" style={{ width: 72, height: 28 }} />
      ) : (
        <span className="mfh-stat__value">{value}</span>
      )}
      <span className="mfh-stat__hint">{hint ?? ''}</span>
    </div>
  );
}
