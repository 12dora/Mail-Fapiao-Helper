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
//     --sha <commit sha> --version <package version> \
//     [--channel stable|development] --out <file>

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
const channel = arg('channel', 'stable');
const out = arg('out', 'release-notes.md');

if (!tag || !sha || !version) {
  console.error('compose-release-notes: --tag, --sha and --version are required');
  process.exit(2);
}
if (channel !== 'stable' && channel !== 'development') {
  console.error(`compose-release-notes: --channel must be "stable" or "development", got "${channel}"`);
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

const mismatched = infos.filter(
  (info) => info.version !== version
    || (info.commit && info.commit !== sha)
    || (info.tag && info.tag !== tag),
);
if (mismatched.length > 0) {
  console.error('compose-release-notes: build metadata does not match the resolved release ref:');
  for (const info of mismatched) {
    console.error(
      `  - ${info.name}: version=${info.version} commit=${info.commit ?? '<none>'} tag=${info.tag ?? '<none>'} `
      + `(expected version=${version} commit=${sha} tag=${tag})`,
    );
  }
  process.exit(1);
}

const wrongChannel = infos.filter((info) => info.channel !== channel);
const signatureMismatch = channel === 'stable'
  ? infos.filter((info) => !info.signed)
  : infos.filter((info) => info.signed);
const macTrustMismatch = channel === 'stable'
  ? infos.filter((info) => info.platform === 'mac' && !info.notarized)
  : infos.filter((info) => info.platform === 'mac' && info.notarized);

if (wrongChannel.length > 0 || signatureMismatch.length > 0 || macTrustMismatch.length > 0) {
  console.error(`compose-release-notes: artifact trust metadata does not match channel "${channel}":`);
  for (const info of wrongChannel) {
    console.error(`  - ${info.name}: channel=${info.channel} (expected "${channel}")`);
  }
  for (const info of signatureMismatch) {
    console.error(`  - ${info.name}: signed=${info.signed} (unexpected for "${channel}")`);
  }
  for (const info of macTrustMismatch) {
    console.error(`  - ${info.name}: notarized=${info.notarized} (unexpected for "${channel}")`);
  }
  process.exit(1);
}

const lines = [];

if (channel === 'development') {
  lines.push('## ⚠️ 未签名预发布版');
  lines.push('');
  lines.push('**这不是正式稳定版。macOS 产物只有 ad-hoc 签名且未经 Apple 公证；Windows 产物没有 Authenticode 签名。操作系统无法验证发布者身份，只有在你信任本仓库并核对 `SHA256SUMS.txt` 后才应继续。**');
  lines.push('');
  lines.push('此版本被标记为 GitHub **prerelease**，文件名均带 `-unsigned`，不会作为自动更新的稳定通道。');
  lines.push('');
}

lines.push('## 来源（provenance）');
lines.push('');
lines.push(`- 标签（tag）：\`${tag}\``);
lines.push(`- 源码提交（commit）：\`${sha}\``);
lines.push(`- package.json 版本：\`${version}\``);
lines.push('');
lines.push('所有二进制均由该 commit 构建；手动发布会校验 tag 已存在、解析到该 commit，且 semver 与 package.json 一致。');
lines.push('');

lines.push('## 签名状态');
lines.push('');
lines.push('| 产物 | 代码签名 | 公证 / 时间戳 |');
lines.push('|---|---|---|');
for (const info of infos) {
  if (channel === 'stable') {
    const notaryCell = info.platform === 'mac'
      ? '✅ 已公证并 staple'
      : '✅ Authenticode + RFC3161 时间戳';
    lines.push(`| ${info.name} | ✅ 已签名 | ${notaryCell} |`);
  } else {
    const signatureCell = info.platform === 'mac' ? '⚠️ 仅 ad-hoc 签名' : '⚠️ 未签名';
    const trustCell = info.platform === 'mac' ? '❌ 未公证 / 未 staple' : '❌ 无 Authenticode 时间戳';
    lines.push(`| ${info.name} | ${signatureCell} | ${trustCell} |`);
  }
}
lines.push('');

if (channel === 'stable') {
  lines.push('发布流水线在打包后逐个产物执行严格校验：macOS 跑 `codesign --verify --deep --strict`、`spctl --assess`、`stapler validate`，Windows 校验 Authenticode 状态与时间戳反签名。任一项失败即中止发布。');
  lines.push('');
  lines.push('未签名构建只能进入明确标注的 GitHub prerelease，不能进入此稳定发布通道。');
  lines.push('');
} else {
  lines.push('发布流水线验证了包结构、平台二进制隔离、测试代码排除和 `-unsigned` 文件名；它**没有**声称这些二进制具有可信开发者签名。');
  lines.push('');
  lines.push('## macOS：在确认来源后允许打开');
  lines.push('');
  lines.push('1. 下载后先正常尝试打开一次，让 macOS 记录拦截。');
  lines.push('2. 打开“系统设置” → “隐私与安全性”。');
  lines.push('3. 在“安全性”区域找到该 App，点击“仍要打开（Open Anyway）”。该按钮通常只在首次拦截后约一小时内显示。');
  lines.push('4. 输入登录密码并再次确认“打开”。macOS 会只为这个 App 保存例外。');
  lines.push('');
  lines.push('不要全局关闭 Gatekeeper，也不要对来源不明的文件执行此操作。Apple 官方说明：<https://support.apple.com/guide/mac-help/mh40616/mac>');
  lines.push('');
  lines.push('## Windows 提示');
  lines.push('');
  lines.push('Windows Defender SmartScreen / Smart App Control 可能阻止未签名安装包。只有在核对来源与 SHA-256 后才继续；如果系统提供“更多信息 → 仍要运行”，可按需使用。部分 Windows 11 Smart App Control 模式不支持单个 App 例外，此时请不要关闭整机安全保护来强行安装。');
  lines.push('');
  lines.push('Microsoft 官方说明：<https://support.microsoft.com/windows/smart-app-control-frequently-asked-questions>');
  lines.push('');
}

writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`compose-release-notes: wrote ${out} (${infos.length} platform(s), channel=${channel})`);
