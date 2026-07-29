# Git 历史隐私净化（尚未执行）

> **状态：NOT EXECUTED — 需要仓库所有者在维护窗口人工批准后执行。**
>
> 当前工作树中的敏感字符串已在本轮被 **scrub（只改当前文件）**。  
> 公开 Git 历史、tag 与 GitHub 自动生成的源码归档中 **仍然** 含有原值。  
> 本文档给出完整的 `git filter-repo` 步骤；**禁止**在未获批准时执行任何历史重写或 force-push。

## 背景

公开仓库曾提交真实发票号、商户名、金额、邮件主题、Message-Id 与本机缓存路径，位置包括：

| 路径 | 敏感内容类型 |
|---|---|
| `docs/SAMPLE_ANALYSIS.md` | 邮件主题、发票号码、发件人、商户 |
| `docs/PROGRESS.md` | 样本 hash、票号、商户、本机路径 |
| `docs/EFAPIAO_UPSTREAM_FEEDBACK.md` | 票号、hash、发件人、本机 `.mfh-cache` 路径 |
| `gui-design/tests/cli-regression.mjs` | 真实商户 + 金额 + 发票号码 组合（OCR 去重 fixture） |

当前树中的上述内容已替换为明显虚构值。历史净化是独立的后续动作。

## 执行前检查清单

1. 通知所有协作者：历史即将重写，本地 clone 将失效。
2. 备份全部 refs：
   ```bash
   git clone --mirror https://github.com/12dora/Mail-Fapiao-Helper.git mfh-mirror-backup
   tar czf mfh-mirror-backup-$(date +%Y%m%d).tar.gz mfh-mirror-backup
   ```
3. 在 **全新 clone** 中操作，不要在日常工作副本上执行。
4. 确认本机已安装 [`git-filter-repo`](https://github.com/newren/git-filter-repo)。
5. 若仓库仍为 public 且尚未完成 scrub 推送，可先考虑临时 private（可选，需 owner 决定）。

## 推荐净化方案（路径删除 + 测试字符串替换）

在 fresh clone 根目录：

### 1. 生成替换表（不向终端打印原值）

历史中的测试 fixture 行可能仍含真实商户/票号。若当前树已 scrub，需从 **mirror backup 的旧 commit** 提取原值，或使用下列已知敏感字面量（仅作 filter-repo 输入，勿再写入文档正文）：

```bash
# 在仍含原值的 mirror / 旧 tag 检出上运行；输出仅写入 0600 文件
node - <<'NODE'
const fs = require('node:fs');
// 若你手头仍有 scrub 前的 cli-regression.mjs 备份：
const candidates = [
  process.env.MFH_OLD_CLI_REGRESSION,
  'gui-design/tests/cli-regression.mjs',
].filter(Boolean);
let line;
for (const p of candidates) {
  if (!fs.existsSync(p)) continue;
  line = fs.readFileSync(p, 'utf8')
    .split('\n')
    .find((value) => value.includes("'same-hash") && value.includes(',success,'));
  if (line) break;
}
if (!line) {
  console.error('sensitive OCR fixture row not found — fill /private/tmp/mfh-history-redactions.txt manually');
  process.exit(1);
}
const row = line.trim().replace(/^'/, '').replace(/',$/, '').split(',');
// columns: ... invoiceType,seller,amount,dateValue,invoiceNo, ...
const seller = row[10];
const invoiceNo = row[13];
if (!seller || !invoiceNo) throw new Error('could not parse seller/invoiceNo');
fs.writeFileSync(
  '/private/tmp/mfh-history-redactions.txt',
  [
    `literal:${seller}==>示例餐饮有限公司`,
    `literal:${invoiceNo}==>00000000000000000000`,
    // 可选：继续补充历史文档中出现的票号/商户字面量
  ].join('\n') + '\n',
  { mode: 0o600 },
);
console.log('wrote /private/tmp/mfh-history-redactions.txt (mode 0600); contents not printed');
NODE
```

### 2. 过滤路径并替换字面量

```bash
git filter-repo --force \
  --path docs/SAMPLE_ANALYSIS.md \
  --path docs/PROGRESS.md \
  --path docs/EFAPIAO_UPSTREAM_FEEDBACK.md \
  --invert-paths \
  --replace-text /private/tmp/mfh-history-redactions.txt
```

说明：

- `--invert-paths` 从 **全部历史** 中删除三份敏感过程文档（当前树若需保留匿名版，应在重写后重新添加 scrub 后的版本并单独 commit）。
- `--replace-text` 替换测试 fixture 中的票面字符串，避免仅删文档后历史仍残留测试行。

### 3. 重写 tag

`git filter-repo` 默认会更新指向已改写 commit 的 tag。检查：

```bash
git tag -l
git log --oneline --decorate -5
# 确认敏感字符串不再出现于任意 ref：
git grep -n "示例餐饮有限公司" $(git rev-list --all) || true
# 用原敏感字面量（勿写进脚本仓库）再 grep 一次，期望 0 命中
```

### 4. 重新添加远端并 force-push（需二次人工确认）

```bash
git remote add origin https://github.com/12dora/Mail-Fapiao-Helper.git
# STOP：确认备份、协作者通知、维护窗口后再执行
git push --force origin --all
git push --force origin --tags
```

## 重写后必须完成的后续动作

1. **协作者**：删除旧 clone，重新 `git clone`；不要 `git pull` 已重写的历史。
2. **Forks**：请 fork 所有者重新 fork，或自行 `filter-repo` + force-push；GitHub 不会自动更新 fork。
3. **GitHub Releases 源码归档**：每个 Release 的 “Source code (zip/tar.gz)” 绑定旧 SHA。重写后应：
   - 编辑/重建相关 Release 说明，标注 provenance SHA 已变更；或
   - 删除并重建 prerelease（若可接受），使源码归档指向新 SHA。
4. **外部缓存**：检查 CI 缓存、镜像站、已分发的 zip、邮件附件中的旧 tarball。
5. **Secrets 轮换**：若历史中曾出现任何凭据（本轮审查未发现 IMAP 密码入库，但若你怀疑有），立即轮换。
6. **验证**：
   ```bash
   git rev-list --all | xargs git grep -l '2631200000' || echo 'no invoice-like hits'
   gh api repos/12dora/Mail-Fapiao-Helper/commits --jq '.[0].sha'
   ```

## 明确未做的事

- 未运行 `git filter-repo`
- 未 `git push --force`
- 未修改仓库可见性
- 未删除 GitHub Release 资产

## 联系

仅仓库 owner / 维护者可批准执行。执行后在 PR 或 issue 中记录完成时间与新 HEAD SHA。
