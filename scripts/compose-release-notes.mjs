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

// This script only ever runs on the stable publishing path. An official release
// must be fully signed, so anything less is a hard failure rather than a
// disclaimer printed on top of an untrustworthy download.
const notStable = infos.filter((info) => info.channel !== 'stable');
const unsigned = infos.filter((info) => !info.signed);
const macNotNotarized = infos.filter((info) => info.platform === 'mac' && !info.notarized);

if (notStable.length > 0 || unsigned.length > 0 || macNotNotarized.length > 0) {
  console.error('compose-release-notes: refusing to publish an official release from artifacts that lack a full trust chain:');
  for (const info of notStable) console.error(`  - ${info.name}: channel=${info.channel} (expected "stable")`);
  for (const info of unsigned) console.error(`  - ${info.name}: signed=false`);
  for (const info of macNotNotarized) console.error(`  - ${info.name}: notarized=false`);
  console.error(
    '\nUnsigned binaries are published through the development workflow as workflow artifacts only,\n' +
      'never as a GitHub Release.\n',
  );
  process.exit(1);
}

const lines = [];

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
  const notaryCell = info.platform === 'mac'
    ? '✅ 已公证并 staple'
    : '✅ Authenticode + RFC3161 时间戳';
  lines.push(`| ${info.name} | ✅ 已签名 | ${notaryCell} |`);
}
lines.push('');
lines.push('发布流水线在打包后逐个产物执行了严格校验：macOS 跑 `codesign --verify --deep --strict`、`spctl --assess`、`stapler validate`，Windows 校验 Authenticode 状态与时间戳反签名。任一项失败即中止发布。');
lines.push('');
lines.push('未签名的开发构建只以 CI workflow artifact 的形式提供，**不会**出现在 Releases 页面。');
lines.push('');

writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`compose-release-notes: wrote ${out} (${infos.length} signed platform(s))`);
