/**
 * 全应用唯一的提示出口。
 *
 * 文案规则：`title` 是结果本身，20 字以内、不带感叹号、不出现代码里的标识符；
 * `detail` 是可选的一句话补充（原因或下一步），没有就别写。
 * 只有 title 时用轻量的 message；带 detail 时用 notification，用户需要时间读完。
 */
import type { MessageInstance } from 'antd/es/message/interface';
import type { NotificationInstance } from 'antd/es/notification/interface';

type Level = 'success' | 'info' | 'warning' | 'error';

let holder: { message: MessageInstance; notification: NotificationInstance } | null = null;

/** 由 App 内部的 NotifyHolder 组件在挂载时注入，业务代码不要调用。 */
export function setNotifyHolder(next: typeof holder): void {
  holder = next;
}

const DURATION: Record<Level, number> = { success: 2.5, info: 2.5, warning: 4, error: 6 };

function show(level: Level, title: string, detail?: string): void {
  if (!holder) {
    console.warn(`[notify] ${level}: ${title}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  if (detail) {
    holder.notification[level]({
      message: title,
      description: detail,
      placement: 'bottomRight',
      duration: DURATION[level],
    });
    return;
  }
  void holder.message.open({ type: level, content: title, duration: DURATION[level] });
}

export const notify = {
  success: (title: string, detail?: string) => show('success', title, detail),
  info: (title: string, detail?: string) => show('info', title, detail),
  warning: (title: string, detail?: string) => show('warning', title, detail),
  error: (title: string, detail?: string) => show('error', title, detail),
};

/** IPC 结果的统一提示：ok 走 success，否则走 error，detail 取 detail ?? error。 */
export function notifyResult(
  result: { ok?: boolean; message?: string; detail?: string; error?: string },
  fallback: { success: string; failure: string },
): void {
  const title = result.message?.trim() || (result.ok ? fallback.success : fallback.failure);
  const detail = result.detail?.trim() || (result.ok ? undefined : result.error?.trim());
  if (result.ok) notify.success(title, detail);
  else notify.error(title, detail);
}
