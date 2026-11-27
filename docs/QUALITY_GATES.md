# 代码质量门禁

可执行的唯一依据是 `eslint.config.mjs`（所有规则均为 error），本文只说明规则的意图与使用方式。

## 规则

- ESLint 9 flat config，覆盖 `src/**/*.ts`、`scripts/**/*.mjs`、`gui-design/tests/**/*.mjs`、`gui-design/src/**/*.{ts,tsx}`。
- 上限：后端单文件 700 行代码、单函数 120 行（不计注释与空行，IIFE 不豁免）、圈复杂度 20、嵌套深度 4、参数 6 个。
- 其他：TODO/FIXME 注释、未使用变量（下划线参数除外）、未使用的私有成员、`prefer-const`、严格相等；后端启用 `await-thenable`（需要类型信息）；渲染层启用 React Hooks 规则。
- 测试代码不检查函数长度与复杂度，其余规则照常生效。
- 已有的结构性超限在 `eslint.config.mjs` 中以「具名文件 / 具名函数的有限额度」登记（`functionBaselines`、`structuralBaselines`），不是关闭规则；重构后应收紧，新增代码不得再扩大额度。

## 运行

| 命令 | 作用 |
| --- | --- |
| `npm run lint` | ESLint 全量检查 |
| `npm run typecheck` | 主进程与渲染层两份 tsconfig |
| `npm run smells` / `npm run smells -- --json` | 仅报告性质的词法统计（按物理行数；不阻止提交，输出中说明了解析上的局限） |
| `npm run test:tooling` | 门禁脚本自检（含 `scripts/check-code-gates.mjs`） |

`npm run test:core` 先跑 lint，CI 也会单独跑一次 lint。

## 本地提交钩子（自愿）

- 启用：`MFH_INSTALL_GIT_HOOKS=1 npm run postinstall`（CI 中不会安装）。Windows PowerShell 先 `$env:MFH_INSTALL_GIT_HOOKS="1"`。
- pre-commit 执行 `npm run lint -- --max-warnings 0 && npm run typecheck`。
- 确需跳过本次本地检查：`SKIP_SIMPLE_GIT_HOOKS=1 git commit ...`，CI 仍会检查。
