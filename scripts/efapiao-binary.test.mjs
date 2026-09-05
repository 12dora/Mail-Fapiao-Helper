import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { okResult } from '../dist/ocr/efapiao/result.js';

test('prefers newest version across roots, falls back on Windows and honors overrides', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfh-binary-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const arch = Object.getOwnPropertyDescriptor(process, 'arch');
  const env = { ...process.env };
  // Isolate the repository fallback so future Windows vendor upgrades cannot affect this fixture.
  const moduleDir = path.join(tmp, 'dist', 'ocr', 'efapiao');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('../dist/ocr/efapiao/binary.js', import.meta.url), path.join(moduleDir, 'binary.js'));
  const logPath = path.join(tmp, 'dist', 'log.js');
  fs.copyFileSync(new URL('../dist/log.js', import.meta.url), logPath);
  const { binaryPath, resolvedBinaryVersion } = await import(pathToFileURL(path.join(moduleDir, 'binary.js')).href);
  const { log } = await import(pathToFileURL(logPath).href);
  const info = log.info;
  const messages = [];
  const cfg = { ocr: { binaryPath: 'auto' } };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    process.env.MFH_RESOURCE_ROOT = path.join(tmp, 'resources');
    process.env.MFH_APP_ROOT = path.join(tmp, 'app');
    log.info = (message) => messages.push(message);
    const install = (root, version) => {
      const bin = path.join(root, 'vendor', 'efapiao', version, 'windows-x86_64', 'nested', 'efapiao.exe');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, 'fixture');
      return bin;
    };
    const old = install(process.env.MFH_RESOURCE_ROOT, '0.1.3');
    assert.equal(binaryPath(cfg), old);
    assert.equal(resolvedBinaryVersion(cfg), '0.1.3');
    assert.match(messages.pop(), /selected bundled version 0\.1\.3/);
    const newest = install(process.env.MFH_APP_ROOT, '0.1.4');
    assert.equal(binaryPath(cfg), newest);
    assert.equal(resolvedBinaryVersion(cfg), '0.1.4');
    assert.equal(messages.length, 0);
    cfg.ocr.binaryPath = '/custom/efapiao';
    assert.equal(binaryPath(cfg), '/custom/efapiao');
    assert.equal(resolvedBinaryVersion(cfg), undefined);
    cfg.ocr.binaryPath = 'auto';
    Object.defineProperty(process, 'platform', { value: 'unsupported-test-platform' });
    assert.equal(binaryPath(cfg), 'efapiao');
    assert.equal(resolvedBinaryVersion(cfg), undefined);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    process.env = env;
    log.info = info;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('provenance follows the response for both transports and supporting classes', () => {
  for (const transport of ['cli', 'http']) {
    const result = okResult({ data: {
      document_type: 'pdf-supporting',
      source: { parser_version: '0.1.0', ocr_vendor: 'none', format: 'pdf' },
    } }, 'invoice', transport);
    assert.equal(result.fields.documentType, 'supporting');
    assert.equal(result.source.parserVersion, '0.1.0');
    assert.equal(result.source.ocrVendor, 'none');
  }
});
