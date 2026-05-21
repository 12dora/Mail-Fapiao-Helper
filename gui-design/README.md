# 发票助手 · 桌面界面预览

这里是发票助手的桌面界面。普通浏览器里可以作为静态预览打开；在 Electron 里会通过 `window.mfhBridge` 连接本机配置、邮件缓存、OCR 汇总和 CLI 操作。

## 打开方式

桌面应用开发模式：

```bash
npm run electron
```

这会先编译 TypeScript，再打开 Electron 窗口。Electron 会读取项目根目录的 `config.json`；邮件缓存、发票原件、识别结果都保存在本机，不会上传。

静态预览：

从项目根目录启动本地预览：

```bash
cd gui-design && python3 -m http.server 5175
```

然后打开 <http://127.0.0.1:5175/>。静态预览不会调用本机 CLI，主要用于查看界面。

## 页面

```
gui-design/
  index.html                 — 入口页
  styles/main.css            — 亮色默认、深色可选的桌面端样式
  scripts/shell.js           — 侧栏、主题、按钮反馈、Electron 数据绑定
  tests/e2e.mjs              — Playwright 端到端检查
  tests/electron-smoke.mjs   — Electron 桥接冒烟检查
  pages/
    dashboard.html           — 开始处理：抓邮件、保存票据、查看进度
    inbox.html               — 邮件记录：已扫描邮件与来源
    library.html             — 发票库：识别结果、支撑材料、整理入口
    pending.html             — 待确认：链接过期、缺文件、需手动处理
    config.html              — 邮箱与保存：邮箱登录、保存位置、命名方式
    settings.html            — 关于：隐私说明、版本、后续计划
```

## 设计要求

- 默认使用亮色主题，用户可以切换深色主题。
- 面向非技术用户，页面避免直接暴露内部状态词。
- 侧栏、按钮和运行日志均已中文化。
- Electron 中通过 `window.mfhBridge` 读取真实摘要，并调用本地 `fetch/run/ocr/organize/pending` 能力。
- 所有邮件、附件、识别结果都按“先保存原件，再识别整理”的用户心智呈现。

## 测试

从项目根目录运行：

```bash
node gui-design/tests/e2e.mjs
node gui-design/tests/electron-smoke.mjs
```

测试会检查默认亮色主题、中文导航、开始处理流程、待确认页按钮反馈、设置页文案、主题切换、页面是否横向溢出，以及 Electron preload 桥是否可用。
