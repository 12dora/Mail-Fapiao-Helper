import {
  FileTextOutlined,
  InboxOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { App as AntApp, ConfigProvider, Layout, Menu, theme } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import { useEffect, type ReactNode } from 'react';
import { useAppInfo, useSummary } from './bridge/index.js';
import { OpBanner, setNotifyHolder } from './components/index.js';
import { DashboardPage } from './pages/dashboard/DashboardPage.js';
import { InboxPage } from './pages/inbox/InboxPage.js';
import { LibraryPage } from './pages/library/LibraryPage.js';
import { PendingPage } from './pages/pending/PendingPage.js';
import { SettingsPage } from './pages/settings/SettingsPage.js';
import { navigate, useRoute, type RouteKey } from './router.js';
import { darkTheme, lightTheme, MONO_STACK, useColorScheme } from './theme.js';

const NAV: { key: RouteKey; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: '开始处理', icon: <PlayCircleOutlined /> },
  { key: 'inbox', label: '邮件记录', icon: <InboxOutlined /> },
  { key: 'library', label: '发票库', icon: <FileTextOutlined /> },
  { key: 'pending', label: '待确认', icon: <WarningOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
];

const PAGES: Record<RouteKey, () => JSX.Element> = {
  dashboard: DashboardPage,
  inbox: InboxPage,
  library: LibraryPage,
  pending: PendingPage,
  settings: SettingsPage,
};

/** 把 antd 的令牌暴露成 CSS 变量，app.css 里那几处手写布局才能跟着主题走。 */
function ThemeVars(): null {
  const { token } = theme.useToken();
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--mfh-border', token.colorBorderSecondary);
    root.setProperty('--mfh-surface', token.colorBgContainer);
    root.setProperty('--mfh-text-dim', token.colorTextTertiary);
    root.setProperty('--mfh-mono', MONO_STACK);
    document.body.style.background = token.colorBgLayout;
  }, [token]);
  return null;
}

/** antd 5 的 message / notification 需要 App 上下文，这里注入给 notify 帮手。 */
function NotifyHolder(): null {
  const { message, notification } = AntApp.useApp();
  useEffect(() => {
    setNotifyHolder({ message, notification });
    return () => setNotifyHolder(null);
  }, [message, notification]);
  return null;
}

function Sidebar(): JSX.Element {
  const route = useRoute();
  const { data: summary } = useSummary();
  const { data: info } = useAppInfo();
  const pendingCount = summary?.pending.total ?? 0;

  return (
    <Layout.Sider width={204} className="mfh-sider" theme="light">
      <div className="mfh-brand">
        <span className="mfh-brand__name">发票助手</span>
        <span className="mfh-brand__sub">本机运行，数据不外传</span>
      </div>
      <Menu
        mode="inline"
        selectedKeys={[route.key]}
        onClick={({ key }) => navigate(key as RouteKey)}
        style={{ borderInlineEnd: 0, background: 'transparent' }}
        items={NAV.map((item) => ({
          key: item.key,
          icon: item.icon,
          label:
            item.key === 'pending' && pendingCount > 0 ? (
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{item.label}</span>
                <span className="mfh-num" style={{ opacity: 0.6 }}>
                  {pendingCount}
                </span>
              </span>
            ) : (
              item.label
            ),
        }))}
      />
      <div className="mfh-sider__foot">
        <span>{info ? `v${info.version}` : ''}</span>
        <span>{info && info.channel !== 'release' ? info.channel : ''}</span>
      </div>
    </Layout.Sider>
  );
}

function Shell(): JSX.Element {
  const route = useRoute();
  const Page = PAGES[route.key];
  return (
    <Layout className="mfh-shell" hasSider>
      <Sidebar />
      <Layout className="mfh-main">
        <OpBanner />
        <Page />
      </Layout>
    </Layout>
  );
}

export function App(): JSX.Element {
  const scheme = useColorScheme();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={scheme === 'dark' ? darkTheme : lightTheme}
      button={{ autoInsertSpace: false }}
    >
      <AntApp style={{ height: '100%' }}>
        <ThemeVars />
        <NotifyHolder />
        <Shell />
      </AntApp>
    </ConfigProvider>
  );
}
