/**
 * 主题令牌。
 *
 * 一个强调色（#2F6BFF），其余全部是中性面；状态色只出现在标签和进度条上。
 * 深色跟随系统 `prefers-color-scheme`，用 antd 的 darkAlgorithm，不另建一套色板。
 */
import { theme, type ThemeConfig } from 'antd';
import { useEffect, useState } from 'react';

/** 中文优先的系统字体栈，不加载任何外部字体（CSP 只允许 self）。 */
export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", sans-serif';

export const MONO_STACK = '"SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

const shared: ThemeConfig['token'] = {
  colorPrimary: '#2F6BFF',
  colorInfo: '#2F6BFF',
  colorSuccess: '#1D9A6C',
  colorWarning: '#C8811A',
  colorError: '#D0342C',
  borderRadius: 8,
  fontSize: 13,
  fontFamily: FONT_STACK,
  fontFamilyCode: MONO_STACK,
  wireframe: false,
  motionDurationMid: '0.14s',
};

/** 表格、卡片这些高密度控件统一压扁一档，保持桌面工具的信息密度。 */
const components: ThemeConfig['components'] = {
  Table: {
    headerBg: 'transparent',
    cellPaddingBlockSM: 7,
    cellPaddingInlineSM: 12,
    headerBorderRadius: 0,
    rowHoverBg: 'rgba(47, 107, 255, 0.06)',
  },
  Card: { paddingLG: 16 },
  Layout: { siderBg: 'transparent', headerHeight: 52 },
  Menu: { itemHeight: 34, itemMarginInline: 6, iconMarginInlineEnd: 10, itemBorderRadius: 6 },
  Descriptions: { labelBg: 'transparent' },
  Segmented: { itemSelectedBg: '#ffffff' },
};

export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: { ...shared, colorBgLayout: '#F4F5F7', colorBorderSecondary: '#E7E9ED' },
  components,
};

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: { ...shared, colorBgLayout: '#15171C', colorBgContainer: '#1C1F26', colorBorderSecondary: '#2A2E37' },
  components: {
    ...components,
    Segmented: { itemSelectedBg: '#2A2E37' },
  },
};

/** 跟随系统深色设置；用户没有单独的主题开关，桌面工具跟系统走即可。 */
export function useColorScheme(): 'light' | 'dark' {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);
  return dark ? 'dark' : 'light';
}
