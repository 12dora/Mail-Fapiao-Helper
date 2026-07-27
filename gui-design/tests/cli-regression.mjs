/* CLI regression suite — narrow, per-bug assertions against the compiled CLI.
 *
 * Broad end-to-end coverage (archive → CSV → state → OCR → organize) lives in
 * cli-integration.mjs; this file keeps one focused regression per past defect.
 *
 * CODE-02: every check below must fail when the behaviour it names regresses.
 * "the file exists" / "the file is non-empty" style assertions are not allowed
 * here — they stayed green through real breakage before.
 */

import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertFreshBuild, fail, repoRoot, runSuite } from './_shared.mjs';

const execFileAsync = promisify(execFile);

async function writeConfig(tmp, overrides = {}) {
  const cfg = {
    // schema v3: no `llm` block, and `output` carries only `csv` — the archive
    // and pending directories come from paths.*.
    schemaVersion: 3,
    imap: { host: 'imap.example.com', port: 993, user: 'me@example.com', pass: '***', tls: true, mailbox: [] },
    filter: { keywords: ['发票'], matchSubject: true, matchBody: true, sinceDays: 30, since: null, until: null },
    paths: { samples: join(tmp, 'raw'), invoices: join(tmp, 'invoices'), pending: join(tmp, 'pending') },
    output: { csv: join(tmp, 'custom', 'invoices.csv') },
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
    playwright: { headless: true, timeoutMs: 30000 },
    network: { retries: 0, retryDelayMs: 0 },
    ...overrides,
  };
  const path = join(tmp, 'config.json');
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { cfg, path };
}

function mockOcrConfig(tmp) {
  return {
    ocr: {
      enabled: true,
      provider: 'mock',
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
  };
}

const PDF_BYTES_B64 = 'JVBERi0xLjQKJUVPRgo=';

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
    PDF_BYTES_B64,
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
    cwd: repoRoot,
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Parses a BOM-prefixed CSV into { header: string[], rows: string[][] }. */
function parseSimpleCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/).filter(Boolean);
  return {
    header: (lines[0] || '').split(','),
    rows: lines.slice(1).map((line) => line.split(',')),
  };
}

function column(csv, row, name) {
  const index = csv.header.indexOf(name);
  if (index < 0) fail(`CSV 缺少列 ${name}：${csv.header.join(',')}`);
  return row[index] ?? '';
}

async function testOutputCsvAndPendingRaw() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-regression-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  const pdfEml = pdfMail('<pdf-case@example.com>');
  const manualEml = manualMail('普通发票通知', '<manual-case@example.com>');
  await writeFile(join(tmp, 'raw', 'pdf.eml'), pdfEml);
  await writeFile(join(tmp, 'raw', 'manual.eml'), manualEml);

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);

  // 1. The ledger goes to output.csv, not to a second copy under paths.invoices.
  if (!existsSync(cfg.output.csv)) fail('mfh run did not write config.output.csv');
  if (existsSync(join(cfg.paths.invoices, 'invoices.csv'))) fail('mfh run still wrote paths.invoices/invoices.csv');

  // The ledger must describe the archived artifact, not merely exist.
  const ledger = parseSimpleCsv(await readFile(cfg.output.csv, 'utf8'));
  if (ledger.rows.length !== 1) {
    fail(`output.csv should hold exactly the one archived attachment, got ${ledger.rows.length} rows`);
  }
  const ledgerRow = ledger.rows[0];
  if (column(ledger, ledgerRow, 'messageId') !== '<pdf-case@example.com>') {
    fail(`output.csv row is not the PDF mail: ${ledgerRow.join(',')}`);
  }
  if (column(ledger, ledgerRow, 'source') !== 'invoice.pdf') {
    fail(`output.csv lost the original attachment name: ${ledgerRow.join(',')}`);
  }
  const archivedName = column(ledger, ledgerRow, 'filename');
  const archivedBytes = await readFile(join(cfg.paths.invoices, archivedName));
  if (!archivedBytes.equals(Buffer.from(PDF_BYTES_B64, 'base64'))) {
    fail(`archived ${archivedName} does not contain the attachment bytes byte-for-byte`);
  }

  // 2. Exactly one pending row, for the mail that had nothing to download.
  const pending = parseSimpleCsv(await readFile(join(cfg.paths.pending, 'pending.csv'), 'utf8'));
  if (pending.rows.length !== 1) fail(`pending.csv should contain one data row, got ${pending.rows.length}`);
  if (column(pending, pending.rows[0], 'messageId') !== '<manual-case@example.com>') {
    fail(`pending.csv holds the wrong mail: ${pending.rows[0].join(',')}`);
  }
  if (column(pending, pending.rows[0], 'subject') !== '普通发票通知') {
    fail(`pending.csv lost the subject: ${pending.rows[0].join(',')}`);
  }

  // 3. The quarantined .eml is the *original* raw message, byte-for-byte — the
  //    old `size > 0` check passed even when a truncated or re-serialised copy
  //    was written.
  const pendingEmls = (await readdir(cfg.paths.pending)).filter((name) => name.endsWith('.eml'));
  if (pendingEmls.length !== 1) fail(`expected one pending eml, got ${pendingEmls.length}`);
  const preserved = await readFile(join(cfg.paths.pending, pendingEmls[0]), 'utf8');
  if (preserved !== manualEml) {
    fail(`pending eml is not a byte-identical copy of the raw message:\n${JSON.stringify(preserved.slice(0, 200))}`);
  }
}

async function testPendingWithoutMessageId() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-noid-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await writeFile(join(tmp, 'raw', 'noid1.eml'), manualMail('无ID发票通知1'));
  await writeFile(join(tmp, 'raw', 'noid2.eml'), manualMail('无ID发票通知2'));

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);

  const pending = parseSimpleCsv(await readFile(join(cfg.paths.pending, 'pending.csv'), 'utf8'));
  if (pending.rows.length !== 2) fail(`pending.csv should keep both no-Message-ID rows, got ${pending.rows.length}`);
  const subjects = pending.rows.map((row) => column(pending, row, 'subject')).sort();
  if (subjects[0] !== '无ID发票通知1' || subjects[1] !== '无ID发票通知2') {
    fail(`the two no-Message-ID mails collapsed into one identity: ${JSON.stringify(subjects)}`);
  }
}

async function testCsvStateRecovery() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-recover-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  await mkdir(cfg.paths.invoices, { recursive: true });
  await writeFile(join(tmp, 'raw', 'recover.eml'), pdfMail('<recover-case@example.com>'));
  const archivedBefore = '%PDF-1.4\n%ALREADY-ARCHIVED\n%EOF\n';
  await writeFile(join(cfg.paths.invoices, 'invoice.pdf'), archivedBefore);
  const ledgerBefore = [
    '﻿messageId,date,from,subject,filename,source',
    '<recover-case@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,invoice.pdf,invoice.pdf',
    '',
  ].join('\n');
  await writeFile(cfg.output.csv, ledgerBefore);

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);

  // Old assertion was "invoice-1.pdf does not exist", which also passed when the
  // run wrote invoice-2.pdf, re-archived under a different name, or appended a
  // duplicate ledger row. Assert the full post-state instead.
  const archived = (await readdir(cfg.paths.invoices)).filter((name) => name.toLowerCase().endsWith('.pdf'));
  if (archived.length !== 1 || archived[0] !== 'invoice.pdf') {
    fail(`recovering state from output.csv must not re-archive anything; found ${JSON.stringify(archived)}`);
  }
  const archivedAfter = await readFile(join(cfg.paths.invoices, 'invoice.pdf'), 'utf8');
  if (archivedAfter !== archivedBefore) fail('the already-archived invoice was overwritten during recovery');

  const ledger = parseSimpleCsv(await readFile(cfg.output.csv, 'utf8'));
  if (ledger.rows.length !== 1) {
    fail(`output.csv should still hold one row after recovery, got ${ledger.rows.length}`);
  }
  if (column(ledger, ledger.rows[0], 'filename') !== 'invoice.pdf') {
    fail(`output.csv row was rewritten during recovery: ${ledger.rows[0].join(',')}`);
  }
}

async function testOcrSingleItemResume() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-ocr-single-'));
  const { cfg, path: configPath } = await writeConfig(tmp, mockOcrConfig(tmp));
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

  const results = parseSimpleCsv(await readFile(cfg.ocr.resultsCsv, 'utf8'));
  if (results.rows.length !== 2) {
    fail(`single-item OCR should append exactly one new result row, got ${results.rows.length}`);
  }
  const todoRow = results.rows.find((row) => column(results, row, 'hash') === 'hash-todo');
  if (!todoRow) fail(`single-item OCR did not append the hash-todo result:\n${results.rows.map((r) => r.join(',')).join('\n')}`);
  if (column(results, todoRow, 'status') !== 'success' || column(results, todoRow, 'seller') !== '国家电网有限公司') {
    fail(`the newly parsed row lost its fields: ${todoRow.join(',')}`);
  }
  const alreadyRow = results.rows.find((row) => column(results, row, 'hash') === 'hash-already');
  if (column(results, alreadyRow, 'invoiceNo') !== 'EXISTING') {
    fail(`resuming rewrote the pre-existing result row: ${alreadyRow.join(',')}`);
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

/* CODE-03: no absolute millisecond budget.
 *
 * The previous version asserted `elapsed < 900ms` for a run that also pays Node
 * startup, module import and file I/O — and, worse, it passed `--concurrency 4`
 * with MFH_MOCK_OCR_FAIL_BATCH=1, which routes into parseBatch, throws before
 * the artificial delay, and therefore never exercised parallelism at all.
 *
 * The check below runs the *same* workload twice in the *same* environment —
 * once strictly serial (--single-item), once with --concurrency N — and asserts
 * that the parallel run recovers a real share of the theoretical saving. Node
 * startup and I/O appear in both measurements and cancel out in the difference,
 * so a slow machine shifts both numbers instead of turning the suite red.
 */
async function testOcrConcurrencyRunsInParallel() {
  const ITEMS = 4;
  const DELAY_MS = 400;

  async function prepare(prefix) {
    const tmp = await mkdtemp(join(tmpdir(), prefix));
    const { cfg, path: configPath } = await writeConfig(tmp, mockOcrConfig(tmp));
    const ocrDir = join(cfg.paths.invoices, 'ocr');
    await mkdir(ocrDir, { recursive: true });
    const rows = ['﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason'];
    for (let i = 1; i <= ITEMS; i++) {
      const file = `${i}.pdf`;
      await writeFile(join(cfg.paths.invoices, file), '%PDF-1.4\n%EOF\n');
      rows.push(`hash-${i},<${i}@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,${file},${file},pdf,invoice,pending,`);
    }
    rows.push('');
    await writeFile(join(ocrDir, 'ocr-pending.csv'), rows.join('\n'));
    return configPath;
  }

  async function measure(prefix, extraArgs) {
    const configPath = await prepare(prefix);
    const started = Date.now();
    const { stdout } = await runMfh(['ocr', 'run', '--config', configPath, ...extraArgs], {
      // Guard: the per-item path must be used, so a regression that silently
      // re-routes into parseBatch fails loudly instead of finishing instantly.
      MFH_MOCK_OCR_FAIL_BATCH: '1',
      MFH_MOCK_OCR_DELAY_MS: String(DELAY_MS),
    });
    const elapsed = Date.now() - started;
    if (!stdout.includes(`OCR complete: scanned=${ITEMS}, parsed=${ITEMS}, skipped=0, failed=0`)) {
      fail(`OCR run did not parse all ${ITEMS} items (${extraArgs.join(' ')}):\n${stdout}`);
    }
    return elapsed;
  }

  const serialMs = await measure('mfh-cli-ocr-serial-', ['--single-item']);
  const parallelMs = await measure('mfh-cli-ocr-concurrency-', ['--concurrency', String(ITEMS)]);

  // Perfect parallelism saves (ITEMS - 1) * DELAY_MS. Require at least half of
  // that, which is far above scheduling noise yet impossible to reach when the
  // items are processed one after another.
  const theoreticalSaving = (ITEMS - 1) * DELAY_MS;
  const observedSaving = serialMs - parallelMs;
  if (observedSaving < theoreticalSaving / 2) {
    fail(
      `OCR --concurrency ${ITEMS} did not run in parallel: serial=${serialMs}ms parallel=${parallelMs}ms `
      + `saving=${observedSaving}ms, expected at least ${theoreticalSaving / 2}ms of the ${theoreticalSaving}ms theoretical saving`,
    );
  }
}

await runSuite('CLI regression tests', async () => {
  await assertFreshBuild();
  await testOutputCsvAndPendingRaw();
  await testPendingWithoutMessageId();
  await testCsvStateRecovery();
  await testOcrSingleItemResume();
  await testOcrSuccessBeatsLaterFailure();
  await testOcrDedupeFallsBackToFilename();
  await testOcrConcurrencyRunsInParallel();
}, { timeoutMs: 4 * 60 * 1000 });
