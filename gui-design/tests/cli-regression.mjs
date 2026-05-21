import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(message);
}

async function writeConfig(tmp, overrides = {}) {
  const cfg = {
    imap: { host: 'imap.example.com', port: 993, user: 'me@example.com', pass: '***', tls: true, mailbox: [] },
    filter: { keywords: ['发票'], matchSubject: true, matchBody: true, sinceDays: 30, since: null, until: null },
    paths: { samples: join(tmp, 'raw'), invoices: join(tmp, 'invoices'), pending: join(tmp, 'pending') },
    output: { dir: join(tmp, 'invoices'), pendingDir: join(tmp, 'pending'), csv: join(tmp, 'custom', 'invoices.csv') },
    rename: {
      rule: '{seller}-{amount}.pdf',
      fallback: '{date}-{messageId}.pdf',
      applyAfterOcr: false,
      organizeByType: false,
      typeDirRule: '{documentType}',
      organizedDir: join(tmp, 'organized'),
    },
    ocr: {
      enabled: true,
      provider: 'efapiao',
      binaryPath: 'auto',
      executionMode: 'cli',
      serviceUrl: 'http://127.0.0.1:8000',
      serviceHost: '127.0.0.1',
      servicePort: 8000,
      serviceWorkers: 1,
      serviceStartupMs: 30000,
      batchSize: 16,
      timeoutMs: 120000,
      resultsCsv: join(tmp, 'ocr-results.csv'),
      credentials: { tencentRegion: 'ap-shanghai' },
    },
    llm: { enabled: false, provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: '' },
    playwright: { headless: true, timeoutMs: 30000 },
    network: { retries: 0, retryDelayMs: 0 },
    ...overrides,
  };
  const path = join(tmp, 'config.json');
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { cfg, path };
}

function pdfMail(messageId, subject = '发票') {
  return [
    'From: vendor@example.com',
    'To: me@example.com',
    `Subject: ${subject}`,
    'Date: Thu, 21 May 2026 10:00:00 +0800',
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '发票见附件。',
    '--b',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQKJUVPRgo=',
    '--b--',
    '',
  ].join('\n');
}

function manualMail(subject, messageId = '') {
  const headers = [
    'From: notice@example.com',
    'To: me@example.com',
    `Subject: ${subject}`,
    'Date: Thu, 21 May 2026 11:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (messageId) headers.splice(4, 0, `Message-ID: ${messageId}`);
  return [
    ...headers,
    '',
    '请登录平台查看发票。',
    '',
  ].join('\n');
}

async function runMfh(args) {
  return execFileAsync('node', ['dist/index.js', ...args], {
    cwd: new URL('../..', import.meta.url),
    maxBuffer: 1024 * 1024,
  });
}

async function testOutputCsvAndPendingRaw() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-regression-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await writeFile(join(tmp, 'raw', 'pdf.eml'), pdfMail('<pdf-case@example.com>'));
  await writeFile(join(tmp, 'raw', 'manual.eml'), manualMail('普通发票通知', '<manual-case@example.com>'));

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);

  if (!existsSync(cfg.output.csv)) fail('mfh run did not write config.output.csv');
  if (existsSync(join(cfg.paths.invoices, 'invoices.csv'))) fail('mfh run still wrote paths.invoices/invoices.csv');

  const pendingCsv = await readFile(join(cfg.paths.pending, 'pending.csv'), 'utf8');
  const rows = pendingCsv.trim().split(/\r?\n/);
  if (rows.length !== 2) fail(`pending.csv should contain one data row, got ${rows.length - 1}`);

  const pendingFiles = (await readdir(cfg.paths.pending))
    .filter((name) => name.endsWith('.eml'))
    .map((name) => join(cfg.paths.pending, name));
  if (pendingFiles.length !== 1) fail(`expected one pending eml, got ${pendingFiles.length}`);
  const size = (await stat(pendingFiles[0])).size;
  if (size <= 0) fail('pending eml should preserve original raw message bytes');
}

async function testPendingWithoutMessageId() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-noid-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await writeFile(join(tmp, 'raw', 'noid1.eml'), manualMail('无ID发票通知1'));
  await writeFile(join(tmp, 'raw', 'noid2.eml'), manualMail('无ID发票通知2'));

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);

  const pendingCsv = await readFile(join(cfg.paths.pending, 'pending.csv'), 'utf8');
  const rows = pendingCsv.trim().split(/\r?\n/);
  if (rows.length !== 3) fail(`pending.csv should keep both no-Message-ID rows, got ${rows.length - 1}`);
}

async function testCsvStateRecovery() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-recover-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  await mkdir(cfg.paths.invoices, { recursive: true });
  await writeFile(join(tmp, 'raw', 'recover.eml'), pdfMail('<recover-case@example.com>'));
  await writeFile(join(cfg.paths.invoices, 'invoice.pdf'), '%PDF-1.4\n%EOF\n');
  await writeFile(cfg.output.csv, [
    '﻿messageId,date,from,subject,filename,source',
    '<recover-case@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,invoice.pdf,invoice.pdf',
    '',
  ].join('\n'));

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);

  if (existsSync(join(cfg.paths.invoices, 'invoice-1.pdf'))) {
    fail('mfh run duplicated an archived invoice instead of recovering state from output.csv');
  }
}

await testOutputCsvAndPendingRaw();
await testPendingWithoutMessageId();
await testCsvStateRecovery();
console.log('CLI regression tests passed');
