# 发票助手 · 桌面界面

单页界面，React 18 + Ant Design 5，由 esbuild 打包成 `gui-design/dist/app.js`。
Electron 里通过 `window.mfhBridge` 连接本机配置、邮件缓存、OCR 汇总和 CLI 操作；
浏览器里带 `?fake=1` 打开时使用内存假数据，只用于查看界面。

## 目录

```
gui-design/
  index.html   唯一入口，带 CSP，加载 dist/app.js
  src/         渲染层源码，见 src/README.md
  dist/        构建产物，不入库
  tests/       Playwright 检查
```

## 开发

```bash
npm run electron       # 编译主进程 + 渲染层，打开 Electron 窗口
npm run dev:renderer   # 渲染层 watch 构建
npm run screenshots    # 自带静态服务器，按路由截图到 docs/screenshots/
```

静态预览：先 `npm run build:renderer`，再从 `gui-design/` 起一个静态服务器，
打开 `index.html?fake=1#/dashboard`。

## 路由

| 路由 | 页面 |
| --- | --- |
| `#/dashboard` | 开始处理：时间范围、匹配范围、试运行、运行日志、本次结果、最近运行 |
| `#/inbox` | 邮件记录 |
| `#/library` | 发票库 |
| `#/pending` | 待确认 |
| `#/settings` | 设置：邮箱 / 保存与整理 / 识别 / 关于 |

路由只走 hash：主进程只允许加载 `gui-design/index.html`，换成新的 `file:` 路径会被
`isCanonicalAppPageUrl` 拒绝，进而挡掉所有 IPC。

## 约定

界面文案、桥接订阅规则、主题令牌与新增页面的步骤见 [`src/README.md`](src/README.md)。

## 测试

`gui-design/tests/` 下的用例仍指向旧界面，会随本次重写另行更新。
