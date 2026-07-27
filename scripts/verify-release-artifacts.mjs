#!/usr/bin/env node
// Post-package artifact audit (CODE-04 / CODE-06).
//
// Runs against the unpacked output electron-builder leaves in release/ and
// fails the build when:
//
//   * the package carries an executable built for another platform
//     (a macOS package must not ship PE/.exe, a Windows package must not ship
//     Mach-O) — CODE-06;
//   * more than one vendor/efapiao/<version>/<platform-arch> directory made it
//     into the package, or the wrong one did — CODE-06;
//   * app.asar still contains the test suites or the dev fake backend — CODE-04.
//
// Usage: node scripts/verify-release-artifacts.mjs --platform <mac|win>

import { openSync, readSync, closeSync, readdirSync, statSync, existsSync } from 'node:fs';
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

const EXPECTED_VENDOR_DIR = platform === 'mac' ? 'darwin-arm64' : 'windows-x86_64';
const errors = [];
const notes = [];

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

/* -------------------------------------------------------------------- main */

const roots = findUnpackedRoots();
for (const root of roots) {
  checkForeignExecutables(root);
  checkVendorLayout(root);
  checkAsarHygiene(root);
}

for (const note of notes) console.log(`  ok: ${note}`);

if (errors.length > 0) {
  console.error(`\nverify-release-artifacts (${platform}) FAILED:\n`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('');
  process.exit(1);
}

console.log(`\nverify-release-artifacts (${platform}) passed\n`);
