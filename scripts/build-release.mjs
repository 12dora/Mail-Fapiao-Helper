#!/usr/bin/env node
// Release build wrapper (CODE-05A).
//
// electron-builder is invoked through this script so that the *channel* a build
// belongs to is decided up front and can never drift:
//
//   --channel stable       (.github/workflows/release.yml)
//     Signing is mandatory. Missing macOS/Windows certificates, or missing
//     Apple notarization credentials, abort the build BEFORE electron-builder
//     runs. A stable build is always signed, notarized (macOS) and timestamped
//     (Windows) — there is no degraded stable build.
//
//   --channel development  (.github/workflows/dev-build.yml, local `npm run dist:*`)
//     Unsigned. macOS gets an ad-hoc signature only so the arm64 app can launch
//     at all. Every artifact filename carries an `-unsigned` suffix. These may
//     be uploaded as short-lived workflow artifacts or through the isolated
//     unsigned-prerelease workflow, which must mark the GitHub Release as a
//     prerelease and display explicit trust warnings.
//
// The channel is recorded in release/build-info-<platform>-<arch>.json and is
// re-checked by scripts/verify-release-artifacts.mjs, so an unsigned binary can
// never reach the stable publishing path.
//
// Usage:
//   node scripts/build-release.mjs [--mac|--win] [--channel stable|development]
//                                  [extra electron-builder args...]
//   (channel also readable from MFH_RELEASE_CHANNEL; defaults to development)

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

const channelIndex = argv.indexOf('--channel');
const channel = (channelIndex === -1 ? process.env.MFH_RELEASE_CHANNEL : argv[channelIndex + 1]) || 'development';
if (channel !== 'stable' && channel !== 'development') {
  console.error(`build-release: --channel must be "stable" or "development", got "${channel}"`);
  process.exit(2);
}

const channelValueIndex = channelIndex === -1 ? -1 : channelIndex + 1;
const passthrough = argv.filter(
  (arg, index) => arg !== '--mac' && arg !== '--win' && arg !== '--channel' && index !== channelValueIndex,
);

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

// ---------------------------------------------------------------------------
// Stable channel is fail-closed. This is deliberately duplicated with the guard
// in .github/workflows/release.yml: even if someone edits the workflow gate
// away, the stable channel still cannot emit an unsigned binary.
// ---------------------------------------------------------------------------
if (channel === 'stable') {
  // HYG-04: fail-closed — stable channel must never ship a prerelease package version.
  const pkgVersion = String(pkg.version || '');
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pkgVersion)) {
    console.error(
      `\n[build-release] refusing STABLE build for prerelease package version "${pkgVersion}".\n` +
        'Stable releases require package.json version MAJOR.MINOR.PATCH with no suffix.\n' +
        'Use --channel development (or the unsigned-prerelease workflow) for prerelease tags.\n',
    );
    process.exit(1);
  }

  const missing = [];
  if (!signed) {
    missing.push(
      platform === 'mac'
        ? 'macOS Developer ID certificate (CSC_LINK + CSC_KEY_PASSWORD, from the MACOS_CERTIFICATE_P12 / MACOS_CERTIFICATE_PASSWORD secrets)'
        : 'Windows Authenticode certificate (WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD, from the WINDOWS_CERTIFICATE_PFX / WINDOWS_CERTIFICATE_PASSWORD secrets)',
    );
  }
  if (platform === 'mac' && !notarizeConfigured) {
    missing.push(
      'Apple notarization credentials (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, ' +
        'or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)',
    );
  }
  if (missing.length > 0) {
    console.error('\n[build-release] refusing to produce a STABLE build without a full trust chain.\n');
    for (const item of missing) console.error(`  - missing: ${item}`);
    console.error(
      '\nA stable release must be signed, notarized (macOS) and timestamped (Windows); an unsigned\n' +
        'binary must never be published as an official release. To produce an unsigned build for\n' +
        'testing, use the development channel instead:\n' +
        '\n' +
        '  node scripts/build-release.mjs --channel development ...\n' +
        '  or run an explicitly unsigned development/prerelease workflow.\n',
    );
    process.exit(1);
  }
}

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
        'and Gatekeeper will still warn on first launch. This is only tolerated on the ' +
        'development channel.',
    );
  }
} else {
  console.warn(
    `[build-release] no ${platform === 'mac' ? 'macOS' : 'Windows'} code-signing certificate in the environment ` +
      `(${platform === 'mac' ? 'CSC_LINK' : 'WIN_CSC_LINK/CSC_LINK'}); ` +
      'producing an UNSIGNED development build. Artifacts are suffixed with "-unsigned" and ' +
      'must never be published as a stable GitHub Release.',
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
console.log(`[build-release] channel=${channel} platform=${platform} arch=${arch} signed=${signed} notarized=${notarized}`);
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
  channel,
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
  writeFileSync(process.env.GITHUB_OUTPUT, `channel=${channel}\nsigned=${signed}\nnotarized=${notarized}\n`, { flag: 'a' });
}

console.log(`[build-release] wrote ${path.relative(repoRoot, path.join(outDir, `build-info-${platform}-${arch}.json`))}`);
