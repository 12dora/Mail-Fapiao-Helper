import { Tag } from 'antd';

type Tone = 'success' | 'processing' | 'warning' | 'error' | 'default';

interface Preset {
  tone: Tone;
  label: string;
}

/**
 * 状态到颜色的唯一映射。新状态一律加到这里，不要在页面里临时决定颜色。
 * 键覆盖发票库状态、邮件状态、运行历史状态和待确认动作。
 */
const PRESETS: Record<string, Preset> = {
  // 发票库
  完整: { tone: 'success', label: '已识别' },
  信息不完整: { tone: 'warning', label: '待补充' },
  已归档: { tone: 'default', label: '已归档' },
  识别失败: { tone: 'error', label: '识别失败' },
  // 邮件
  archived: { tone: 'success', label: '已归档' },
  pending: { tone: 'warning', label: '待确认' },
  unprocessed: { tone: 'processing', label: '待处理' },
  ignored: { tone: 'default', label: '无发票' },
  // 运行历史
  success: { tone: 'success', label: '成功' },
  partial: { tone: 'warning', label: '部分完成' },
  failed: { tone: 'error', label: '失败' },
  // 待确认分组动作
  retry: { tone: 'processing', label: '可重试' },
  refresh_link: { tone: 'warning', label: '链接失效' },
  manual_archive: { tone: 'warning', label: '手动归档' },
  ignore: { tone: 'default', label: '可忽略' },
};

export interface StatusTagProps {
  status: string;
  /** 覆盖默认文案；不传就用映射表里的中文标签。 */
  label?: string;
}

export function StatusTag({ status, label }: StatusTagProps): JSX.Element {
  const preset = PRESETS[status] ?? { tone: 'default' as Tone, label: status || '—' };
  return (
    <Tag color={preset.tone} bordered={false}>
      {label ?? preset.label}
    </Tag>
  );
}

/** 供筛选器复用的中文标签。 */
export function statusLabel(status: string): string {
  return PRESETS[status]?.label ?? status;
}
