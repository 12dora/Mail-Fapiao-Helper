import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  /** 一行事实性说明，通常是计数或最近一次运行时间。不要写操作指引。 */
  subtitle?: ReactNode;
  /** 右侧操作区，最右边放主操作。 */
  actions?: ReactNode;
}

/** 每个页面的第一行：标题在左，主操作在右，下面一条分隔线。 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps): JSX.Element {
  return (
    <header className="mfh-pageheader">
      <div>
        <h1 className="mfh-pageheader__title" data-testid="page-title">
          {title}
        </h1>
        {subtitle ? <p className="mfh-pageheader__sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="mfh-pageheader__actions">{actions}</div> : null}
    </header>
  );
}
