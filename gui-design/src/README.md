# Renderer (React 18 + Ant Design 5)

Single-page renderer for the Electron app. Bundled by esbuild into
`gui-design/dist/app.js` + `app.css`, loaded by `gui-design/index.html`.
No CDN, no runtime downloads: everything ships from `node_modules`.

```
npm run build:renderer   # production bundle (also part of npm run build)
npm run dev:renderer     # esbuild watch
npm run typecheck        # tsc -p . && tsc -p tsconfig.renderer.json
npm run screenshots      # static server + ?fake=1 -> docs/screenshots/
```

## Layout

```
gui-design/src/
  main.tsx            entry: dayjs locale, startEventHub(), render <App/>
  App.tsx             ConfigProvider + Layout shell (sider, OpBanner, page slot)
  router.ts           hash router (#/dashboard …), useRoute(), navigate()
  theme.ts            antd tokens, light/dark, useColorScheme()
  app.css             only what tokens cannot express (height chain, log panel)
  bridge/             types.ts (the IPC contract), bridge.ts, hooks.ts, fake/
  components/         shared UI kit — anything used by two pages lives here
    documentType.ts   documentType/invoiceType → one Chinese name
    mail/             the mail-detail sections shared by inbox and pending
  store/              module-level state that must outlive a route change
    run.ts            the current run: range, switches, batch, local log notes
  pages/<name>/       one folder per route; page-local state stays inside it
```

## Preview data

`bridge/fake/` answers every channel from memory when `window.mfhBridge` is
missing or the URL carries `?fake=…`:

| URL | what you get |
| --- | --- |
| `?fake=1` | a normal screenful; this is what `npm run screenshots` captures |
| `?fake=empty` | no mail, no invoices, no pending — the empty states |
| `?fake=broken` | a corrupt config file, every secret stored, `saveConfig` returning a field error |

## Adding a page

1. Create `pages/<name>/<Name>Page.tsx` exporting a component.
2. Add the key to `ROUTE_KEYS` in `router.ts`.
3. Register the label, icon and component in `NAV` / `PAGES` in `App.tsx`.

A page renders exactly two things: a `<PageHeader>` and a `<div className="mfh-scroll">`.
Tables are always `DataTable` (search + chips + pagination); pass `query`/`filterKey`
with their `onChange` when the page itself needs the visible rows — `filterRows()`
is the same algorithm the table runs internally.
The header stays fixed, the scroll area is the only scroller on the screen.
Keep local state, column definitions and drawers inside the page folder; promote
anything a second page needs into `components/` or `bridge/`.

## Bridge hub rule

`electron/preload.cjs` calls `removeAllListeners` before every `on*`
subscription, so **one listener per channel exists at a time**. Two components
subscribing directly would silently unsubscribe each other.

Therefore: `bridge.ts` subscribes once at startup (`startEventHub()` in
`main.tsx`) and fans out. Components must use `subscribe(channel, cb)` or the
`useProgress` / `useOpState` hooks — never `window.mfhBridge.on*` directly, and
never `window.mfhBridge` at all.

`useSummary()`, `useConfig()` and `useAppInfo()` are backed by module-level
stores: the data is fetched once and shared. After any write, call `reload()`
from the hook or `reloadSummary()` from a plain callback.

`primeSummary()` installs the summary a long task hands back in its terminal
result. That one uses the backend's default row limit, not `SUMMARY_QUERY`, so
it is stored as **partial** and only good for making the counters move: every
call site must follow it with `reloadSummary()`, and a page that mounts on a
partial summary reloads it itself.

`useProgress()` reads a module-level store per channel that subscribes at
startup, and the run's own state lives in `store/run.ts`. Both are outside the
route switch on purpose: a run is a chain of awaits, and the user can leave the
dashboard in the middle of one. State that lived in the page would come back
empty while the task kept running.

Routing is hash-only. `pushState` would create a new `file:` path that
`isCanonicalAppPageUrl` rejects, which then breaks every IPC call through the
trusted-sender check.

## Copy rules

- Chinese, sentence case, verbs first: 开始处理 / 打开归档目录 / 复制日志.
- One idea per string. Toast titles ≤ 20 characters, one optional sentence of
  detail. No exclamation marks, no 请注意, no 「静态预览」 or other dev-only concepts.
- Never expose internal identifiers, file paths, channel names or status codes
  in user-facing text — those belong in `detail`.
- Say the outcome, not the mechanism: 已完成，新增 12 份发票, not 管道执行成功.
- Keep one verb per concept across the app: 获取 for fetching, 归档 for archiving,
  识别 for OCR. Do not mix 抓取 / 下载 / 处理 for the same step.
- Empty states tell the user what to do next in one line: 本次运行还没有新邮件.
- All toasts go through `notify.success/info/warning/error(title, detail?)` or
  `notifyResult(result, { success, failure })`. No `window.alert` / `confirm`;
  use antd `Modal.confirm` for destructive actions.

## 测试钩子（`data-testid`）

Playwright 套件只认下面这些钩子，别的地方一律不加——**新增前先问：不加会不会
逼测试去写 antd 的内部类名？** 会，才加。

| 钩子 | 位置 | 谁在用 |
| --- | --- | --- |
| `nav-<route>` | `App.tsx` 侧栏菜单项的 label | 切页、断言五个路由 |
| `page-title` | `PageHeader` 的 `<h1>` | 每个路由的标题 |
| `op-banner` | `OpBanner` 的 Alert | 运行中提示条是否出现 |
| `log-console` | `LogConsole` 根节点 | 日志行、空态文案 |
| `run-card` / `log-card` | 首页运行区的左右两列 | 日志卡必须与运行卡等高 |
| `table-<name>` | `DataTable` 外层容器（`testId` 属性） | 行数、筛选、分页 |
| `table-<name>-search` | 同一张表的搜索框 | 搜索收窄结果 |
| `drawer-<name>` | `DetailDrawer` 正文容器（`testId` 属性） | 抽屉内容 |
| `drawer-title` | `DetailDrawer` 的标题行 | 抽屉标题 |
| `dedupe-report` | 清理重复弹窗的报告区 | 试算结果 |
| `config-error` | 设置页的配置损坏警示条 | `?fake=broken` |
| `action-*` | 主操作按钮 | 点击入口 |
| `toggle-dry-run` | 首页的「试运行」开关 | 预览分支 |

现有的 `table-*`：`batch`、`history`、`inbox`、`library`、`pending`、`dedupe`、
`duplicates`、`mail-documents`。现有的 `drawer-*`：`mail`、`invoice`、`pending`。
现有的 `action-*`：`run-start`、`run-stop`、`export-csv`、`dedupe`、`dedupe-apply`、
`library-ocr`、`pending-retry-all`、`settings-save`。

其余选择器（分段筛选、分页、抽屉、弹窗、进度条、Descriptions、toast）没有稳定的
替代，统一收在 `gui-design/tests/ui-helpers.mjs` 里，antd 升级时只改那一个文件。
截图脚本也从那里取。等待一律等状态（选中、当前页、行内容、探针收到的提示），
不写固定的 `waitForTimeout`。

## Theme tokens

Set in `theme.ts`, consumed through `ConfigProvider`. Do not hardcode colors in
components — read `theme.useToken()` or use the CSS variables that `App.tsx`
mirrors onto `:root` (`--mfh-border`, `--mfh-surface`, `--mfh-text-dim`, `--mfh-mono`).

| token | value | note |
| --- | --- | --- |
| `colorPrimary` | `#2F6BFF` | the only accent; everything else is neutral |
| `borderRadius` | `8` | |
| `fontSize` | `13` | |
| `fontFamily` | system CN stack | no webfonts (CSP allows `'self'` only) |
| `colorBgLayout` | `#F4F5F7` / `#15171C` | page ground, light / dark |
| Table | `size="small"`, transparent header | via `DataTable` |

Dark mode follows `prefers-color-scheme` through `theme.darkAlgorithm`. There is
no in-app theme switch: a desktop tool follows the system.
