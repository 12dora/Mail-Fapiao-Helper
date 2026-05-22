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
      ocrMode: 'auto',
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
    playwright: { headless: true, timeoutMs: 30000, browserManagement: 'app-managed' },
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

async function runMfh(args, env = {}) {
  return execFileAsync('node', ['dist/index.js', ...args], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, ...env },
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

async function testOcrSingleItemResume() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-ocr-single-'));
  const { cfg, path: configPath } = await writeConfig(tmp, {
    ocr: {
      enabled: true,
      provider: 'mock',
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
  });
  const ocrDir = join(cfg.paths.invoices, 'ocr');
  await mkdir(ocrDir, { recursive: true });
  await writeFile(join(cfg.paths.invoices, 'already.pdf'), '%PDF-1.4\n%EOF\n');
  await writeFile(join(cfg.paths.invoices, 'todo.pdf'), '%PDF-1.4\n%EOF\n');
  await writeFile(join(ocrDir, 'ocr-pending.csv'), [
    '﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason',
    'hash-already,<already@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,already.pdf,already.pdf,pdf,invoice,pending,',
    'hash-todo,<todo@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,todo.pdf,todo.pdf,pdf,invoice,pending,',
    '',
  ].join('\n'));
  await writeFile(cfg.ocr.resultsCsv, [
    '﻿hash,messageId,date,from,subject,filename,source,format,documentType,invoiceType,seller,amount,dateValue,invoiceNo,transport,extractedBy,parserVersion,ocrVendor,status,error',
    'hash-already,<already@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,already.pdf,already.pdf,pdf,invoice,电子发票,已识别销售方,1.00,2026-05-21,EXISTING,http,text_layer,mock,,success,',
    '',
  ].join('\n'));

  const { stdout } = await runMfh(['ocr', 'run', '--config', configPath, '--single-item', '--allow-parse-failures'], {
    MFH_MOCK_OCR_FAIL_BATCH: '1',
  });
  if (!stdout.includes('OCR complete: scanned=2, parsed=1, skipped=1, failed=0')) {
    fail(`single-item OCR summary did not show resume behavior:\n${stdout}`);
  }
  if (stdout.includes('mock batch parser should not be used')) {
    fail('single-item OCR invoked parseBatch');
  }

  const pendingCsv = await readFile(join(ocrDir, 'ocr-pending.csv'), 'utf8');
  if (!pendingCsv.includes('already.pdf,already.pdf,pdf,invoice,recognized,already_in_results')) {
    fail(`single-item OCR did not keep existing successful row as resumed:\n${pendingCsv}`);
  }
  if (!pendingCsv.includes('todo.pdf,todo.pdf,pdf,invoice,recognized,')) {
    fail(`single-item OCR did not checkpoint newly parsed row:\n${pendingCsv}`);
  }

  const resultsCsv = await readFile(cfg.ocr.resultsCsv, 'utf8');
  const resultRows = resultsCsv.trim().split(/\r?\n/);
  if (resultRows.length !== 3 || !resultsCsv.includes('hash-todo')) {
    fail(`single-item OCR should append only the new result row:\n${resultsCsv}`);
  }
}

async function testOcrSuccessBeatsLaterFailure() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-ocr-dedupe-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  const ocrDir = join(cfg.paths.invoices, 'ocr');
  await mkdir(ocrDir, { recursive: true });
  await writeFile(join(ocrDir, 'ocr-pending.csv'), [
    '﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason',
    'same-hash,<same@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,same.pdf,same.pdf,pdf,invoice,failed,efapiao timeout after 120000ms',
    '',
  ].join('\n'));
  await writeFile(cfg.ocr.resultsCsv, [
    '﻿hash,messageId,date,from,subject,filename,source,format,documentType,invoiceType,seller,amount,dateValue,invoiceNo,transport,extractedBy,parserVersion,ocrVendor,status,error',
    'same-hash,<same@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,same.pdf,same.pdf,pdf,invoice,电子发票,上海德玺楼餐饮有限公司,188.00,2026-05-21,26312000002724191086,cli,text_layer,0.1.0,,success,',
    'same-hash,<same@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,same.pdf,same.pdf,pdf,invoice,,,,,,,,,,error,efapiao timeout after 120000ms',
    '',
  ].join('\n'));

  const { stdout } = await runMfh(['ocr', 'summary', '--config', configPath]);
  if (!stdout.includes('recognized=1 failed=0 ignored=0 pending=0')) {
    fail(`OCR summary should prefer an existing success over a later failure:\n${stdout}`);
  }
}

async function testOcrDedupeFallsBackToFilename() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-ocr-filename-key-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  const ocrDir = join(cfg.paths.invoices, 'ocr');
  await mkdir(ocrDir, { recursive: true });
  await writeFile(join(ocrDir, 'ocr-pending.csv'), [
    '﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason',
    'hash-a,<a@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,a.pdf,a.pdf,pdf,invoice,recognized,',
    'hash-b,<b@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,行程单,b.pdf,b.pdf,pdf,itinerary,recognized,',
    '',
  ].join('\n'));
  await writeFile(cfg.ocr.resultsCsv, [
    '﻿filename,dateValue,date,seller,invoiceNo,amount,transport,status,documentType,invoiceType,error',
    'a.pdf,2026-05-21,2026-05-21,国家电网有限公司,1234567890,318.42,http,ok,invoice,电子发票,',
    'b.pdf,2026-05-21,2026-05-21,差旅平台,TRIP-20260521,88.00,http,ok,itinerary,行程单,',
    '',
  ].join('\n'));

  const { stdout } = await runMfh(['ocr', 'summary', '--config', configPath]);
  if (!stdout.includes('recognized=2 failed=0 ignored=0 pending=0')) {
    fail(`OCR summary should not collapse legacy result rows without hash/source:\n${stdout}`);
  }
}

async function testOcrConcurrencyRunsInParallel() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-ocr-concurrency-'));
  const { cfg, path: configPath } = await writeConfig(tmp, {
    ocr: {
      enabled: true,
      provider: 'mock',
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
  });
  const ocrDir = join(cfg.paths.invoices, 'ocr');
  await mkdir(ocrDir, { recursive: true });
  const rows = ['﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason'];
  for (let i = 1; i <= 4; i++) {
    const file = `${i}.pdf`;
    await writeFile(join(cfg.paths.invoices, file), '%PDF-1.4\n%EOF\n');
    rows.push(`hash-${i},<${i}@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,${file},${file},pdf,invoice,pending,`);
  }
  rows.push('');
  await writeFile(join(ocrDir, 'ocr-pending.csv'), rows.join('\n'));

  const started = Date.now();
  await runMfh(['ocr', 'run', '--config', configPath, '--concurrency', '4', '--allow-parse-failures'], {
    MFH_MOCK_OCR_FAIL_BATCH: '1',
    MFH_MOCK_OCR_DELAY_MS: '300',
  });
  const elapsed = Date.now() - started;
  if (elapsed > 900) fail(`OCR concurrency did not run in parallel; elapsed=${elapsed}ms`);
}

await testOutputCsvAndPendingRaw();
await testPendingWithoutMessageId();
await testCsvStateRecovery();
await testOcrSingleItemResume();
await testOcrSuccessBeatsLaterFailure();
await testOcrDedupeFallsBackToFilename();
await testOcrConcurrencyRunsInParallel();
console.log('CLI regression tests passed');
