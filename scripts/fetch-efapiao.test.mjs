import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { extractArchive, installArchive, verifyChecksum } from './fetch-efapiao.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'efapiao-fetch-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function manifest(data, name) {
  return `${createHash('sha256').update(data).digest('hex')}  ${name}\n`;
}

async function zipFixture(dir, entries) {
  const zip = new AdmZip();
  for (const [name, contents] of entries) zip.addFile(name, Buffer.from(contents));
  const filename = path.join(dir, 'efapiao-0.1.4-windows-x86_64-lite.zip');
  await fs.writeFile(filename, zip.toBuffer());
  return filename;
}

test('checksum validates exact filename and rejects mismatch, missing and duplicate records', () => {
  const data = Buffer.from('fixture');
  const sums = manifest(data, 'asset.zip');
  assert.equal(verifyChecksum(data, 'asset.zip', sums), sums.trim());
  assert.throws(() => verifyChecksum(Buffer.from('corrupt'), 'asset.zip', sums), /SHA256 mismatch/);
  assert.throws(() => verifyChecksum(data, 'missing.zip', sums), /exactly one/);
  assert.throws(() => verifyChecksum(data, 'asset.zip', sums + sums), /exactly one/);
});

test('ZIP install removes wrapper, preserves existing checksum entries and refuses overwrite', async (t) => {
  const dir = await fixture(t);
  const archivePath = await zipFixture(dir, [['release/efapiao.exe', 'binary'], ['release/README.txt', 'readme']]);
  const vendorDir = path.join(dir, 'vendor');
  await fs.mkdir(path.join(vendorDir, '0.1.4'), { recursive: true });
  const previous = manifest(Buffer.from('local mac'), 'efapiao-0.1.4-darwin-arm64-lite.tar.gz');
  await fs.writeFile(path.join(vendorDir, '0.1.4/SHA256SUMS'), previous);
  const sums = manifest(await fs.readFile(archivePath), path.basename(archivePath));
  const options = { archivePath, manifest: sums, version: '0.1.4', platform: 'windows-x86_64', vendorDir };
  const target = await installArchive(options);
  assert.equal(await fs.readFile(path.join(target, 'efapiao.exe'), 'utf8'), 'binary');
  assert.equal(await fs.readFile(path.join(target, 'README.txt'), 'utf8'), 'readme');
  assert.equal(await fs.readFile(path.join(vendorDir, '0.1.4/SHA256SUMS'), 'utf8'), previous + sums);
  await assert.rejects(installArchive(options), /already exists/);
});

test('checksum failure writes no vendor files', async (t) => {
  const dir = await fixture(t);
  const archivePath = await zipFixture(dir, [['efapiao.exe', 'binary'], ['README.txt', 'readme']]);
  const vendorDir = path.join(dir, 'vendor');
  await assert.rejects(installArchive({ archivePath, manifest: manifest(Buffer.from('wrong'), path.basename(archivePath)), version: '0.1.4', platform: 'windows-x86_64', vendorDir }), /SHA256 mismatch/);
  await assert.rejects(fs.stat(vendorDir), { code: 'ENOENT' });
});

test('tar.gz extracts a wrapped binary and makes it executable', async (t) => {
  const dir = await fixture(t);
  const source = path.join(dir, 'release');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'efapiao'), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
  await fs.writeFile(path.join(source, 'README.txt'), 'readme');
  const archivePath = path.join(dir, 'asset.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', dir, 'release']);
  const destination = path.join(dir, 'extracted');
  await extractArchive(archivePath, destination, 'darwin-arm64');
  assert.equal(await fs.readFile(path.join(destination, 'efapiao'), 'utf8'), '#!/bin/sh\necho fixture\n');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(destination, 'efapiao'))).mode & 0o111, 0o111);
    assert.equal(execFileSync(path.join(destination, 'efapiao'), { encoding: 'utf8' }).trim(), 'fixture');
  }
});

test('tar links are rejected before extraction', { skip: process.platform === 'win32' ? 'Creating symlinks can require Windows administrator privileges' : false }, async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, 'release'));
  await fs.symlink('/etc/passwd', path.join(dir, 'release/efapiao'));
  await fs.writeFile(path.join(dir, 'release/README.txt'), 'readme');
  const archivePath = path.join(dir, 'asset.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', dir, 'release']);
  const destination = path.join(dir, 'extracted');
  await assert.rejects(extractArchive(archivePath, destination, 'darwin-arm64'), /links/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('unsafe ZIP paths and entries outside wrapper are rejected', async (t) => {
  const dir = await fixture(t);
  // Patch equal-length names after serialization because AdmZip sanitizes addFile paths.
  const archivePath = await zipFixture(dir, [['xx/efapiao.exe', 'binary'], ['xx/README.txt', 'readme']]);
  const bytes = await fs.readFile(archivePath);
  for (let index = 0; index < bytes.length - 3; index++) {
    if (bytes.subarray(index, index + 3).toString() === 'xx/') bytes.write('../', index);
  }
  await fs.writeFile(archivePath, bytes);
  await assert.rejects(extractArchive(archivePath, path.join(dir, 'unsafe'), 'windows-x86_64'), /Unsafe archive path/);
  const outside = await zipFixture(dir, [['root/efapiao.exe', 'binary'], ['root/README.txt', 'readme'], ['outside.txt', 'unexpected']]);
  await assert.rejects(extractArchive(outside, path.join(dir, 'outside'), 'windows-x86_64'), /outside the binary directory/);
});

test('ZIP symlinks and duplicate case-insensitive paths are rejected', async (t) => {
  const dir = await fixture(t);
  const zip = new AdmZip();
  zip.addFile('efapiao.exe', Buffer.from('/etc/passwd'));
  zip.getEntry('efapiao.exe').attr = (0o120777 << 16) >>> 0;
  zip.addFile('README.txt', Buffer.from('readme'));
  const archivePath = path.join(dir, 'links.zip');
  await fs.writeFile(archivePath, zip.toBuffer());
  await assert.rejects(extractArchive(archivePath, path.join(dir, 'links'), 'windows-x86_64'), /links/);
  const duplicate = await zipFixture(dir, [['efapiao.exe', 'binary'], ['README.txt', 'readme'], ['readme.txt', 'duplicate']]);
  await assert.rejects(extractArchive(duplicate, path.join(dir, 'duplicates'), 'windows-x86_64'), /Duplicate archive path/);
});
