#!/usr/bin/env node
// Builds the GitHub release body from the per-platform build-info files that
// scripts/build-release.mjs emits (CODE-05A / CODE-05B).
//
// Two things must always be visible to whoever downloads a build:
//   * the exact source commit the binaries were produced from;
//   * whether each artifact is a trusted signed build or an explicitly
//     unsigned development build.
//
// Usage:
//   node scripts/compose-release-notes.mjs --dir <artifacts dir> --tag <tag> \
//     --sha <commit sha> --version <package version> --out <file>

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const dir = arg('dir', 'release-artifacts');
const tag = arg('tag');
const sha = arg('sha');
const version = arg('version');
const out = arg('out', 'release-notes.md');

if (!tag || !sha || !version) {
  console.error('compose-release-notes: --tag, --sha and --version are required');
  process.exit(2);
}

const infos = [];
if (existsSync(dir)) {
  for (const name of readdirSync(dir).sort()) {
    if (!/^build-info-.*\.json$/.test(name)) continue;
    try {
      infos.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
    } catch (err) {
      console.error(`compose-release-notes: cannot parse ${name}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}

if (infos.length === 0) {
  console.error(`compose-release-notes: no build-info-*.json found under ${dir} — refusing to publish a release whose provenance is unknown`);
  process.exit(1);
}

const mismatched = infos.filter((info) => info.version !== version || (info.commit && info.commit !== sha));
if (mismatched.length > 0) {
  console.error('compose-release-notes: build metadata does not match the resolved release ref:');
  for (const info of mismatched) {
    console.error(`  - ${info.name}: version=${info.version} commit=${info.commit ?? '<none>'} (expected version=${version} commit=${sha})`);
  }
  process.exit(1);
}

const unsigned = infos.filter((info) => !info.signed);
const signedNotNotarized = infos.filter((info) => info.signed && info.platform === 'mac' && !info.notarized);

const lines = [];

if (unsigned.length > 0) {
  lines.push('> ⚠️ **本次发布包含未签名的开发构建（unsigned development build）**');
  lines.push('>');
  lines.push('> 未签名的安装包不会通过 macOS Gatekeeper / Windows SmartScreen 的信任校验，');
  lines.push('> 系统无法向你证明文件来源和完整性。请只从本仓库的 Releases 页面下载，');
  lines.push('> 并在安装前核对下方的 commit 与 SHA256。文件名带 `-unsigned` 后缀的即为未签名构建。');
  lines.push('');
}

lines.push('## 来源（provenance）');
lines.push('');
lines.push(`- 标签（tag）：\`${tag}\``);
lines.push(`- 源码提交（commit）：\`${sha}\``);
lines.push(`- package.json 版本：\`${version}\``);
lines.push('');
lines.push('所有二进制均由该 commit 构建，`workflow_dispatch` 手动发布同样会校验 tag 已存在、指向该 commit，且 semver 与 package.json 一致。');
lines.push('');

lines.push('## 签名状态');
lines.push('');
lines.push('| 产物 | 代码签名 | 公证 / 时间戳 |');
lines.push('|---|---|---|');
for (const info of infos) {
  const signCell = info.signed ? '✅ 已签名' : '❌ **未签名（unsigned development build）**';
  const notaryCell = info.platform === 'mac'
    ? (info.notarized ? '✅ 已公证并 staple' : (info.signed ? '⚠️ 未公证' : '—'))
    : (info.signed ? '✅ Authenticode + RFC3161 时间戳' : '—');
  lines.push(`| ${info.name} | ${signCell} | ${notaryCell} |`);
}
lines.push('');

if (signedNotNotarized.length > 0) {
  lines.push('> 部分 macOS 产物已签名但未公证，首次打开仍会看到 Gatekeeper 提示。');
  lines.push('');
}

if (unsigned.length > 0) {
  lines.push('### 未签名构建的处理方式');
  lines.push('');
  lines.push('- **macOS**：在“应用程序”里 **按住 Control 点击图标 → 打开**，弹窗里再点 **打开**。');
  lines.push('  只对这一个 app 放行，不要对整个目录递归执行 `xattr -dr`。');
  lines.push('- **Windows**：SmartScreen 提示时点 **更多信息 → 仍要运行**。');
  lines.push('- 受管设备 / 企业环境不建议部署未签名构建，请等待签名版本或自行从源码构建。');
  lines.push('');
}

writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`compose-release-notes: wrote ${out} (${infos.length} platform(s), ${unsigned.length} unsigned)`);
