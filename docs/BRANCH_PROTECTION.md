# main 分支保护规则（需 owner 在 GitHub 配置）

> **HYG-05**：CI workflow 已覆盖 macOS/Windows 核心测试与 Chromium E2E，但仓库级
> Ruleset / branch protection 目前为空，因此失败检查不会阻止合并或直推。
> 本文档记录 **应配置的规则**；修改 GitHub 仓库设置需要 owner 人工操作，本仓库无法用文件完成。

## 推荐 Ruleset（Settings → Rules → Rulesets）

| 项 | 值 |
|---|---|
| 名称 | `main-required-checks` |
| Enforcement | Active |
| Target | Branch：`main` |
| Require a pull request before merging | 是（至少 1 次 review 可选，按团队习惯） |
| Require status checks to pass | 是 |
| Required checks | 见下表（名称必须与 `ci.yml` job 名一致） |
| Require branches to be up to date | 建议开启 |
| Block force pushes | 是 |
| Block deletions | 是 |
| Bypass list | 仅紧急维护角色，且保留审计；不要整库 bypass |

### 必过检查名（与 `.github/workflows/ci.yml` 对齐）

配置前请在一次成功的 CI run 中核对 **精确 check 名**（GitHub UI 区分大小写与括号）：

1. `Typecheck + tests (macOS arm64)`（或 matrix 展开后的等价名）
2. `Typecheck + tests (Windows x64)`
3. `Browser E2E (Chromium)`

若 job 名称在 `ci.yml` 中调整，同步更新本 Ruleset。

## 配置后的只读复核

```bash
gh api repos/12dora/Mail-Fapiao-Helper/rulesets
gh api repos/12dora/Mail-Fapiao-Helper/branches/main/protection
```

期望：`main` 受保护 / ruleset 为 active，且上述 checks 列为 required。

## 与发布通道的关系

- `release.yml` / `unsigned-prerelease.yml` / `dev-build.yml` 各自再跑测试，发布物有独立门禁。
- 本 Ruleset 保护的是 **日常集成质量**（PR 与直推 `main`），不能替代发布 workflow。
