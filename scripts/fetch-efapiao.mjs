import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

export function verifyChecksum(archive, filename, manifest) {
  const matches = manifest.split(/\r?\n/).map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
    .filter((match) => match?.[2] === filename);
  if (matches.length !== 1) throw new Error(`Expected exactly one SHA256SUMS entry for ${filename}`);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== matches[0][1].toLowerCase()) throw new Error(`SHA256 mismatch for ${filename}`);
  return `${actual}  ${filename}`;
}

function safeName(name) {
  const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
  if (!clean || /[\\\r\n\x00:]/.test(clean) || path.posix.isAbsolute(clean)
      || clean.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  }
  return clean;
}

function zipEntries(archive) {
  return new AdmZip(archive).getEntries().map((entry) => {
    const type = (entry.attr >>> 16) & 0o170000;
    if (type && type !== 0o100000 && type !== 0o040000) throw new Error('Archive links are not allowed');
    return { name: safeName(entry.entryName), directory: entry.isDirectory, data: () => entry.getData() };
  });
}

function tarEntries(archivePath) {
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const names = execFileSync('tar', ['-tzf', archivePath], options).trimEnd().split('\n');
  const listing = execFileSync('tar', ['-tvzf', archivePath], options).trimEnd().split('\n');
  if (names.length !== listing.length || listing.some((line) => !['-', 'd'].includes(line[0]))) {
    throw new Error('Archive links and special files are not allowed');
  }
  return names.map((name, index) => ({
    name: safeName(name), directory: listing[index][0] === 'd',
    // Extract to stdout only; archive paths never control filesystem extraction.
    data: () => execFileSync('tar', ['-xOzf', archivePath, '--', name], { maxBuffer: 512 * 1024 * 1024 }),
  }));
}

export async function extractArchive(archivePath, destination, platform) {
  const entries = archivePath.endsWith('.zip') ? zipEntries(await fs.readFile(archivePath)) : tarEntries(archivePath);
  const binary = platform.startsWith('windows-') ? 'efapiao.exe' : 'efapiao';
  const binaries = entries.filter((entry) => !entry.directory && path.posix.basename(entry.name) === binary);
  if (binaries.length !== 1) throw new Error(`Expected exactly one ${binary} in archive`);
  const root = path.posix.dirname(binaries[0].name);
  const prefix = root === '.' ? '' : `${root}/`;
  const seen = new Set();
  const files = [];
  for (const entry of entries) {
    if (entry.directory && entry.name === root) continue;
    if (!entry.name.startsWith(prefix)) throw new Error('Archive contains files outside the binary directory');
    const relative = safeName(entry.name.slice(prefix.length));
    if (seen.has(relative.toLowerCase())) throw new Error(`Duplicate archive path: ${relative}`);
    seen.add(relative.toLowerCase());
    files.push({ ...entry, relative });
  }
  if (!files.some((entry) => entry.relative === 'README.txt' && !entry.directory)) throw new Error('Archive missing README.txt');
  await fs.mkdir(destination, { recursive: true });
  for (const entry of files) {
    const target = path.join(destination, entry.relative);
    if (entry.directory) {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.data(), { flag: 'wx', mode: entry.relative === binary ? 0o755 : 0o644 });
    }
  }
}

export async function installArchive({ archivePath, manifest, version, platform, vendorDir }) {
  validateOptions(version, platform, 'lite');
  const filename = path.basename(archivePath);
  const checksum = verifyChecksum(await fs.readFile(archivePath), filename, manifest);
  const versionDir = path.join(vendorDir, version);
  const target = path.join(versionDir, platform);
  await fs.mkdir(versionDir, { recursive: true });
  try {
    await fs.lstat(target);
    throw new Error(`Destination already exists: ${target}; inspect it before replacing it`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await fs.mkdtemp(path.join(versionDir, '.fetch-'));
  try {
    await extractArchive(archivePath, stage, platform);
    const sumsPath = path.join(versionDir, 'SHA256SUMS');
    const previous = await fs.readFile(sumsPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const lines = previous.split(/\r?\n/).filter((line) => line.trim() && line.match(/^\S+\s+\*?(.+)$/)?.[1] !== filename);
    await fs.rename(stage, target);
    await fs.writeFile(sumsPath, [...lines, checksum].join('\n') + '\n');
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  return target;
}

function validateOptions(version, platform, flavor) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '')) throw new Error('Provide --version, for example 0.1.4');
  if (!['darwin-arm64', 'windows-x86_64', 'linux-arm64', 'linux-x86_64'].includes(platform)) throw new Error('Unsupported --platform');
  if (!['lite', 'with-model'].includes(flavor)) throw new Error('Unsupported --flavor (lite or with-model)');
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: 'string' }, platform: { type: 'string' }, flavor: { type: 'string', default: 'lite' } } });
  const { version, platform, flavor } = values;
  validateOptions(version, platform, flavor);
  const extension = platform.startsWith('windows-') ? 'zip' : 'tar.gz';
  const filename = `efapiao-${version}-${platform}-${flavor}.${extension}`;
  const base = `https://github.com/12dora/E-Fapiao-OCR/releases/download/v${version}`;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fetch-efapiao-'));
  try {
    const archivePath = path.join(temporary, filename);
    const [archive, manifest] = await Promise.all([download(`${base}/${filename}`), download(`${base}/SHA256SUMS`)]);
    await fs.writeFile(archivePath, archive);
    const vendorDir = fileURLToPath(new URL('../vendor/efapiao/', import.meta.url));
    const target = await installArchive({ archivePath, manifest: manifest.toString('utf8'), version, platform, vendorDir });
    console.log(`Verified and installed ${target}`);
    const buildPlatform = { 'windows-x86_64': 'win', 'darwin-arm64': 'mac' }[platform];
    if (buildPlatform) {
      console.log(`Next: update package.json build.${buildPlatform}.extraResources from/to to vendor/efapiao/${version}/${platform}.`);
      console.log(`Set ${buildPlatform}: '${version}' in scripts/efapiao-vendor.mjs (used by verify-release-artifacts.mjs).`);
      if (buildPlatform === 'mac') console.log(`Set build.mac.binaries to Contents/Resources/vendor/efapiao/${version}/${platform}/efapiao.`);
    }
    console.log('Update vendor/efapiao/README.md, smoke-test the binary, and run npm run test:tooling.');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
