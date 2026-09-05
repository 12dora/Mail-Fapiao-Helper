/**
 * 哈希路由。
 *
 * 主进程只允许加载 gui-design/index.html 这一个页面，所以路由必须走 hash：
 * 换成 pushState 会产生新的 file: 路径，`isCanonicalAppPageUrl` 会拒绝，
 * 随后所有 IPC 都会被 trusted-sender 校验挡掉。
 */
import { useEffect, useState } from 'react';

export const ROUTE_KEYS = ['dashboard', 'inbox', 'library', 'pending', 'settings'] as const;

export type RouteKey = (typeof ROUTE_KEYS)[number];

export const DEFAULT_ROUTE: RouteKey = 'dashboard';

export interface Route {
  key: RouteKey;
  /** 二级片段，目前只有设置页用（邮箱 / 保存与整理 / 识别 / 关于）。 */
  sub: string;
}

function parse(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [head = '', sub = ''] = clean.split('/');
  const key = (ROUTE_KEYS as readonly string[]).includes(head) ? (head as RouteKey) : DEFAULT_ROUTE;
  return { key, sub };
}

export function currentRoute(): Route {
  return parse(typeof window === 'undefined' ? '' : window.location.hash);
}

export function navigate(key: RouteKey, sub?: string): void {
  const next = sub ? `#/${key}/${sub}` : `#/${key}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    // 首次进入没有 hash 时补一个，地址栏和菜单选中状态才一致。
    if (!window.location.hash) window.location.replace(`#/${DEFAULT_ROUTE}`);
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
