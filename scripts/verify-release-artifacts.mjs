#!/usr/bin/env node
// Post-package artifact audit (CODE-04 / CODE-05A / CODE-06).
//
// Runs against the output electron-builder leaves in release/ and fails when:
//
//   * the package carries an executable built for another platform
//     (a macOS package must not ship PE/.exe, a Windows package must not ship
//     Mach-O) — CODE-06;
//   * more than one vendor/efapiao/<version>/<platform-arch> directory made it
//     into the package, or the wrong one did — CODE-06;
//   * app.asar still contains the test suites or the dev fake backend — CODE-04;
//   * the artifacts do not match the trust level their channel promises — CODE-05A:
//       --channel stable      every artifact must carry a real signature.
//                             macOS: codesign --verify --deep --strict, a
//                             non-ad-hoc identity with a Team ID, hardened
//                             runtime, `spctl --assess` accepted, and a stapled
//                             notarization ticket. Windows: Authenticode
//                             signature valid AND countersigned by a timestamp
//                             authority.
//       --channel development artifacts must be *honestly* labelled unsigned
//                             (build-info says so, filenames say so), so they
//                             cannot be mistaken for — or slipped into — a
//                             stable release.
//
// Usage:
//   node scripts/verify-release-artifacts.mjs --platform <mac|win>
//                                             [--channel stable|development]

import { openSync, readSync, closeSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'release');

const platformIndex = process.argv.indexOf('--platform');
const platform = platformIndex === -1 ? (process.platform === 'darwin' ? 'mac' : 'win') : process.argv[platformIndex + 1];
if (platform !== 'mac' && platform !== 'win') {
  console.error('verify-release-artifacts: --platform must be "mac" or "win"');
  process.exit(2);
}

const channelIndex = process.argv.indexOf('--channel');
const channel = (channelIndex === -1 ? process.env.MFH_RELEASE_CHANNEL : process.argv[channelIndex + 1]) || 'development';
if (channel !== 'stable' && channel !== 'development') {
  console.error(`verify-release-artifacts: --channel must be "stable" or "development", got "${channel}"`);
  process.exit(2);
}

const EXPECTED_VENDOR_DIR = platform === 'mac' ? 'darwin-arm64' : 'windows-x86_64';
const errors = [];
const notes = [];

/* ------------------------------------------------------------- subprocesses */

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // codesign/spctl write their findings to stderr.
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  };
}

function powershell(script) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

/* ------------------------------------------------------------------ layout */

function findUnpackedRoots() {
  if (!existsSync(releaseDir)) {
    errors.push(`release/ does not exist — run the packaging step before this check`);
    return [];
  }
  const roots = [];
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(releaseDir, entry.name);
    if (platform === 'mac' && /^mac/.test(entry.name)) {
      for (const inner of readdirSync(full, { withFileTypes: true })) {
        if (inner.isDirectory() && inner.name.endsWith('.app')) {
          roots.push({ appRoot: path.join(full, inner.name), resources: path.join(full, inner.name, 'Contents', 'Resources') });
        }
      }
    } else if (platform === 'win' && /^win.*-unpacked$/.test(entry.name)) {
      roots.push({ appRoot: full, resources: path.join(full, 'resources') });
    }
  }
  if (roots.length === 0) {
    errors.push(`no unpacked ${platform} application found under release/ (looked for ${platform === 'mac' ? 'mac*/**.app' : 'win*-unpacked'})`);
  }
  return roots;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/* ------------------------------------------------- executable format sniff */

const MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function classify(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  if (size < 64) return null;
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    readSync(fd, head, 0, 64, 0);
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'ELF';
    const be = head.readUInt32BE(0);
    // 0xcafebabe collides with Java class files; Mach-O fat binaries always
    // declare a small architecture count, Java declares a version >= 45.
    if (MACHO_MAGICS.has(be)) {
      if (be === 0xcafebabe && head.readUInt32BE(4) > 0x28) return null;
      return 'Mach-O';
    }
    if (head[0] === 0x4d && head[1] === 0x5a) {
      const peOffset = head.readUInt32LE(0x3c);
      if (peOffset > 0 && peOffset + 4 <= size) {
        const pe = Buffer.alloc(4);
        readSync(fd, pe, 0, 4, peOffset);
        if (pe.toString('latin1') === 'PE\0\0') return 'PE';
      }
      return null;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------- asar header */

function readAsarEntries(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerStringLength = head.readUInt32LE(12);
    if (!Number.isFinite(headerStringLength) || headerStringLength <= 0 || headerStringLength > 64 * 1024 * 1024) {
      throw new Error(`implausible asar header length ${headerStringLength}`);
    }
    const raw = Buffer.alloc(headerStringLength);
    readSync(fd, raw, 0, headerStringLength, 16);
    const header = JSON.parse(raw.toString('utf8'));
    const out = [];
    const visit = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        out.push(full);
        if (value && typeof value === 'object' && value.files) visit(value, full);
      }
    };
    visit(header, '');
    return out;
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ checks */

function checkForeignExecutables(root) {
  const forbidden = platform === 'mac' ? new Set(['PE', 'ELF']) : new Set(['Mach-O', 'ELF']);
  let scanned = 0;
  for (const file of walk(root.appRoot)) {
    scanned += 1;
    const kind = classify(file);
    if (kind && forbidden.has(kind)) {
      errors.push(`${kind} executable in a ${platform} package: ${path.relative(releaseDir, file)}`);
    }
  }
  notes.push(`scanned ${scanned} files under ${path.relative(releaseDir, root.appRoot)}`);
}

function checkVendorLayout(root) {
  const vendorRoot = path.join(root.resources, 'vendor', 'efapiao');
  if (!existsSync(vendorRoot)) {
    errors.push(`resources/vendor/efapiao is missing from ${path.relative(releaseDir, root.appRoot)} — the bundled OCR engine would not be found at runtime`);
    return;
  }
  for (const versionEntry of readdirSync(vendorRoot, { withFileTypes: true })) {
    if (!versionEntry.isDirectory()) continue;
    const versionDir = path.join(vendorRoot, versionEntry.name);
    const archDirs = readdirSync(versionDir, { withFileTypes: true })
      .filter((it) => it.isDirectory())
      .map((it) => it.name)
      .sort();
    const unexpected = archDirs.filter((name) => name !== EXPECTED_VENDOR_DIR);
    if (unexpected.length > 0) {
      errors.push(
        `vendor/efapiao/${versionEntry.name} ships cross-platform OCR binaries: ${unexpected.join(', ')} (expected only ${EXPECTED_VENDOR_DIR})`,
      );
    }
    if (!archDirs.includes(EXPECTED_VENDOR_DIR)) {
      errors.push(`vendor/efapiao/${versionEntry.name}/${EXPECTED_VENDOR_DIR} is missing — OCR would fall back to a PATH lookup`);
    } else {
      notes.push(`vendor/efapiao/${versionEntry.name} carries only ${EXPECTED_VENDOR_DIR}`);
    }
  }
}

function checkAsarHygiene(root) {
  const asarPath = path.join(root.resources, 'app.asar');
  if (!existsSync(asarPath)) {
    errors.push(`resources/app.asar is missing from ${path.relative(releaseDir, root.appRoot)}`);
    return;
  }
  let entries;
  try {
    entries = readAsarEntries(asarPath);
  } catch (err) {
    errors.push(`cannot read app.asar header: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const banned = [
    { pattern: /^gui-design\/tests(\/|$)/, label: 'test suite (gui-design/tests)' },
    { pattern: /(^|\/)devFakeBackend\.js(\.map)?$/, label: 'dev fake backend (devFakeBackend.js)' },
  ];
  for (const { pattern, label } of banned) {
    const hits = entries.filter((entry) => pattern.test(entry));
    if (hits.length > 0) {
      errors.push(`production app.asar still contains the ${label}: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}`);
    }
  }
  notes.push(`app.asar carries ${entries.length} entries, free of test code`);
}

/* ------------------------------------------------------- channel + signature */

function readBuildInfo() {
  const name = `build-info-${platform}-${platform === 'mac' ? 'arm64' : 'x64'}.json`;
  const file = path.join(releaseDir, name);
  if (!existsSync(file)) {
    errors.push(`${name} is missing — cannot establish which channel these artifacts belong to`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    errors.push(`cannot parse ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Distributable files users actually download (as opposed to the unpacked tree).
function distributables() {
  if (!existsSync(releaseDir)) return [];
  return readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(dmg|zip|exe)$/i.test(entry.name))
    .map((entry) => path.join(releaseDir, entry.name));
}

function checkChannelConsistency(info) {
  if (!info) return;
  if (info.channel !== channel) {
    errors.push(`build-info declares channel "${info.channel}" but this verification was asked for "${channel}"`);
  }
  const files = distributables();
  const unsignedNamed = files.filter((file) => path.basename(file).includes('-unsigned'));

  if (channel === 'stable') {
    if (!info.signed) {
      errors.push('build-info says signed=false on the stable channel — an unsigned binary must never be published as an official release');
    }
    if (platform === 'mac' && !info.notarized) {
      errors.push('build-info says notarized=false on the stable channel — macOS releases must be notarized and stapled');
    }
    if (unsignedNamed.length > 0) {
      errors.push(`stable artifacts must not be labelled unsigned: ${unsignedNamed.map((f) => path.basename(f)).join(', ')}`);
    }
  } else {
    // Development builds must be *honestly* labelled, so that neither a human
    // nor the stable publishing job can mistake them for a release build.
    if (info.signed) {
      errors.push('build-info says signed=true on the development channel — a signed build must be produced through the stable channel so it is verified and published correctly');
    }
    if (files.length > 0 && unsignedNamed.length !== files.length) {
      const mislabelled = files.filter((file) => !path.basename(file).includes('-unsigned'));
      errors.push(`development artifacts must all carry the "-unsigned" suffix, these do not: ${mislabelled.map((f) => path.basename(f)).join(', ')}`);
    }
    notes.push(`development channel: ${files.length} distributable(s), all labelled unsigned`);
  }
}

function checkMacSignature(root, info) {
  if (process.platform !== 'darwin') {
    errors.push('macOS signature verification requires a macOS runner (codesign/spctl/stapler are unavailable here)');
    return;
  }
  const app = root.appRoot;
  const rel = path.relative(releaseDir, app);

  // 1. Structural integrity of the whole bundle, including nested code.
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (!verify.ok) {
    errors.push(`codesign --verify --deep --strict failed for ${rel}:\n${verify.output.trim()}`);
  } else {
    notes.push(`codesign --verify --deep --strict OK for ${rel}`);
  }

  // 2. Who signed it. Ad-hoc is acceptable for development only.
  const display = run('codesign', ['-dv', '--verbose=4', app]);
  const adhoc = /\bSignature=adhoc\b/.test(display.output) || /\badhoc\b/.test(display.output);
  // codesign prints the literal string "TeamIdentifier=not set" when there is
  // none, so this must be matched to end-of-line — `\S+` would capture "not"
  // and silently look like a real team identifier.
  const teamMatch = display.output.match(/TeamIdentifier=(.*)/);
  const teamIdRaw = teamMatch ? teamMatch[1].trim() : '';
  const teamId = teamIdRaw === '' || teamIdRaw === 'not set' ? 'not set' : teamIdRaw;
  const hardened = /flags=[^\n]*runtime/.test(display.output);

  if (channel === 'stable') {
    if (adhoc) {
      errors.push(`${rel} carries only an ad-hoc signature; a stable release needs a Developer ID identity`);
    }
    if (teamId === 'not set') {
      errors.push(`${rel} has no TeamIdentifier; a stable release must be signed with a Developer ID certificate`);
    }
    if (!hardened) {
      errors.push(`${rel} was not signed with the hardened runtime; notarization requires it`);
    }
    if (!adhoc && teamId !== 'not set' && hardened) {
      notes.push(`${rel} signed by TeamIdentifier=${teamId} with hardened runtime`);
    }

    // 3. Gatekeeper's own verdict — the check that actually predicts what a
    //    user's Mac will do on first launch.
    const assess = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    if (!assess.ok) {
      errors.push(`spctl --assess rejected ${rel}:\n${assess.output.trim()}`);
    } else {
      notes.push(`spctl --assess accepted ${rel} (${assess.output.trim().split('\n').pop()})`);
    }

    // 4. The notarization ticket must be stapled so first launch works offline.
    const staple = run('xcrun', ['stapler', 'validate', app]);
    if (!staple.ok) {
      errors.push(`stapler validate failed for ${rel} — the notarization ticket is not stapled:\n${staple.output.trim()}`);
    } else {
      notes.push(`stapler validate OK for ${rel}`);
    }

    // 5. The nested OCR binary is separately signed; Gatekeeper checks it when
    //    the app spawns it, so an unsigned one breaks OCR at runtime.
    const ocr = path.join(root.resources, 'vendor', 'efapiao', '0.1.3', 'darwin-arm64', 'efapiao');
    if (existsSync(ocr)) {
      const ocrDisplay = run('codesign', ['-dv', '--verbose=4', ocr]);
      if (!run('codesign', ['--verify', '--strict', ocr]).ok) {
        errors.push('the bundled efapiao OCR binary is not validly signed');
      } else if (/\bSignature=adhoc\b/.test(ocrDisplay.output)) {
        errors.push('the bundled efapiao OCR binary carries only an ad-hoc signature on the stable channel');
      } else {
        notes.push('bundled efapiao OCR binary is signed');
      }
    }

    // 6. The .dmg itself is signed by electron-builder when an identity exists.
    //    (The notarization ticket lives on the .app inside it, not on the .dmg.)
    for (const file of distributables().filter((f) => f.endsWith('.dmg'))) {
      const dmg = run('codesign', ['--verify', '--strict', file]);
      if (!dmg.ok) {
        errors.push(`codesign --verify failed for ${path.basename(file)}:\n${dmg.output.trim()}`);
      } else {
        notes.push(`${path.basename(file)} is signed`);
      }
    }
  } else {
    // Development: an ad-hoc signature is expected and required (arm64 macOS
    // refuses to launch a completely unsigned binary), but it must not look
    // like a trusted one.
    if (!adhoc) {
      errors.push(`${rel} is on the development channel but is not ad-hoc signed (TeamIdentifier=${teamId}); a real identity belongs on the stable channel`);
    } else {
      notes.push(`${rel} carries an ad-hoc signature, as expected for a development build`);
    }
  }
}

function checkWindowsSignature(root, info) {
  if (process.platform !== 'win32') {
    errors.push('Windows Authenticode verification requires a Windows runner (powershell/Get-AuthenticodeSignature are unavailable here)');
    return;
  }
  const targets = [
    ...distributables().filter((file) => file.toLowerCase().endsWith('.exe')),
    ...readdirSync(root.appRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map((entry) => path.join(root.appRoot, entry.name)),
  ];

  if (targets.length === 0) {
    errors.push('no .exe found to verify in the Windows package');
    return;
  }

  for (const target of targets) {
    const name = path.basename(target);
    const escaped = target.replace(/'/g, "''");
    const probe = powershell(
      `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'; ` +
        `Write-Output ("status=" + $s.Status); ` +
        `Write-Output ("signer=" + $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '<none>' })); ` +
        `Write-Output ("timestamp=" + $(if ($s.TimeStamperCertificate) { $s.TimeStamperCertificate.Subject } else { '<none>' }))`,
    );
    if (!probe.ok) {
      errors.push(`Get-AuthenticodeSignature failed for ${name}:\n${probe.output.trim()}`);
      continue;
    }
    const status = (probe.stdout.match(/status=(.*)/) || [])[1]?.trim() ?? '<unknown>';
    const signer = (probe.stdout.match(/signer=(.*)/) || [])[1]?.trim() ?? '<none>';
    const timestamp = (probe.stdout.match(/timestamp=(.*)/) || [])[1]?.trim() ?? '<none>';

    if (channel === 'stable') {
      if (status !== 'Valid') {
        errors.push(`${name} Authenticode status is "${status}" (expected Valid); signer=${signer}`);
      } else if (timestamp === '<none>') {
        // Without a countersignature the release stops verifying the day the
        // signing certificate expires.
        errors.push(`${name} is signed but not timestamped — a stable release must be countersigned by a timestamp authority`);
      } else {
        notes.push(`${name} Authenticode Valid, signer=${signer}, timestamped`);
      }
    } else if (status === 'Valid') {
      errors.push(`${name} carries a valid Authenticode signature on the development channel; signed builds must go through the stable channel`);
    }
  }
  if (channel === 'development') {
    notes.push(`${targets.length} Windows executable(s) confirmed unsigned, as expected for a development build`);
  }
}

/* -------------------------------------------------------------------- main */

const buildInfo = readBuildInfo();
checkChannelConsistency(buildInfo);

const roots = findUnpackedRoots();
for (const root of roots) {
  checkForeignExecutables(root);
  checkVendorLayout(root);
  checkAsarHygiene(root);
  if (platform === 'mac') {
    checkMacSignature(root, buildInfo);
  } else {
    checkWindowsSignature(root, buildInfo);
  }
}

for (const note of notes) console.log(`  ok: ${note}`);

if (errors.length > 0) {
  console.error(`\nverify-release-artifacts (${platform}, channel=${channel}) FAILED:\n`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('');
  process.exit(1);
}

console.log(`\nverify-release-artifacts (${platform}, channel=${channel}) passed\n`);
