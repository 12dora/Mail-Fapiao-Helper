#!/usr/bin/env node
// Release build wrapper (CODE-05A).
//
// electron-builder is invoked through this script instead of directly so that
// code signing degrades *explicitly* rather than silently:
//
//   * signing credentials present -> sign (and, on macOS, notarize when Apple
//     credentials are also present); artifacts keep their normal names.
//   * signing credentials absent  -> build an unsigned development build, tag
//     every artifact filename with `-unsigned`, and record the fact in
//     release/build-info-<platform>-<arch>.json so the release workflow can
//     label the GitHub release accordingly.
//
// The build never fails just because secrets are missing: an unsigned build is
// a valid (clearly labelled) outcome, a mislabelled one is not.
//
// Usage: node scripts/build-release.mjs [--mac|--win] [extra electron-builder args...]

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const wantsMac = argv.includes('--mac');
const wantsWin = argv.includes('--win');
const passthrough = argv.filter((arg) => arg !== '--mac' && arg !== '--win');

if (wantsMac && wantsWin) {
  console.error('build-release: pass at most one of --mac / --win (cross-compiling a signed build is not supported here)');
  process.exit(2);
}

const platform = wantsMac ? 'mac' : wantsWin ? 'win' : process.platform === 'darwin' ? 'mac' : 'win';
const arch = platform === 'mac' ? 'arm64' : 'x64';

function nonEmpty(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

// electron-builder reads CSC_LINK/CSC_KEY_PASSWORD generically; Windows also
// accepts the more specific WIN_CSC_LINK. There is no MAC_CSC_LINK.
const macCertConfigured = nonEmpty('CSC_LINK');
const winCertConfigured = nonEmpty('WIN_CSC_LINK') || nonEmpty('CSC_LINK');
const signed = platform === 'mac' ? macCertConfigured : winCertConfigured;

// @electron/notarize accepts any one of these credential triples.
const notarizeConfigured =
  (nonEmpty('APPLE_API_KEY') && nonEmpty('APPLE_API_KEY_ID') && nonEmpty('APPLE_API_ISSUER')) ||
  (nonEmpty('APPLE_ID') && nonEmpty('APPLE_APP_SPECIFIC_PASSWORD') && nonEmpty('APPLE_TEAM_ID')) ||
  (nonEmpty('APPLE_KEYCHAIN') && nonEmpty('APPLE_KEYCHAIN_PROFILE'));

const notarized = platform === 'mac' && signed && notarizeConfigured;

const builderArgs = [platform === 'mac' ? '--mac' : '--win'];
if (platform === 'win') builderArgs.push('--x64');
builderArgs.push('--publish', 'never');

const env = { ...process.env };

if (signed) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  // A configured certificate that fails to apply must break the build rather
  // than quietly produce an unsigned artifact under a signed-looking name.
  builderArgs.push('-c.forceCodeSigning=true');
  if (platform === 'mac' && !notarizeConfigured) {
    console.warn(
      '[build-release] signing certificate found but no Apple notarization credentials ' +
        '(APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID ' +
        'or APPLE_KEYCHAIN/APPLE_KEYCHAIN_PROFILE): the app will be signed but NOT notarized, ' +
        'and Gatekeeper will still warn on first launch.',
    );
  }
} else {
  console.warn(
    `[build-release] no ${platform === 'mac' ? 'macOS' : 'Windows'} code-signing certificate in the environment ` +
      `(${platform === 'mac' ? 'CSC_LINK' : 'WIN_CSC_LINK/CSC_LINK'}); ` +
      'producing an UNSIGNED development build. Artifacts are suffixed with "-unsigned".',
  );
  // Documented switch that stops electron-builder from picking up whatever
  // identity happens to sit in the local keychain.
  //
  // NOTE: do not add `-c.forceCodeSigning=false` here — CLI overrides arrive as
  // strings, and the string "false" is truthy inside electron-builder.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  if (platform === 'mac') {
    // macOS refuses to launch unsigned arm64 binaries, so request an explicit
    // ad-hoc signature ("-"). electron-builder used to fall back to this by
    // itself on arm64; since 26.15 it only does so when asked. An ad-hoc
    // signature carries no identity and no trust — hence the "-unsigned"
    // artifact suffix below. build/entitlements.mac.plist already grants the
    // disable-library-validation entitlement ad-hoc + hardened runtime needs.
    builderArgs.push('-c.mac.identity=-');
  }
  const suffix = '-unsigned';
  const base = pkg.build?.artifactName ?? '${name}-${version}-${arch}.${ext}';
  const nsis = pkg.build?.nsis?.artifactName ?? '${name}-setup-${version}-${arch}.${ext}';
  builderArgs.push(`-c.artifactName=${base.replace('.${ext}', `${suffix}.\${ext}`)}`);
  builderArgs.push(`-c.nsis.artifactName=${nsis.replace('.${ext}', `${suffix}.\${ext}`)}`);
}

builderArgs.push(...passthrough);

const cliPath = require.resolve('electron-builder/cli.js');
console.log(`[build-release] platform=${platform} arch=${arch} signed=${signed} notarized=${notarized}`);
console.log(`[build-release] electron-builder ${builderArgs.join(' ')}`);

const result = spawnSync(process.execPath, [cliPath, ...builderArgs], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[build-release] failed to start electron-builder: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const outDir = path.join(repoRoot, pkg.build?.directories?.output ?? 'release');
mkdirSync(outDir, { recursive: true });
const info = {
  name: platform === 'mac' ? 'macOS arm64' : 'Windows x64',
  platform,
  arch,
  version: pkg.version,
  signed,
  notarized,
  // Provided by CI so the release notes can point at the exact source commit.
  commit: process.env.MFH_RELEASE_SHA ?? null,
  tag: process.env.MFH_RELEASE_TAG ?? null,
  builtAt: new Date().toISOString(),
};
writeFileSync(path.join(outDir, `build-info-${platform}-${arch}.json`), `${JSON.stringify(info, null, 2)}\n`);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `signed=${signed}\nnotarized=${notarized}\n`, { flag: 'a' });
}

console.log(`[build-release] wrote ${path.relative(repoRoot, path.join(outDir, `build-info-${platform}-${arch}.json`))}`);
