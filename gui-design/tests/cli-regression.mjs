/* CLI regression suite — narrow, per-bug assertions against the compiled CLI.
 *
 * Broad end-to-end coverage (archive → CSV → state → OCR → organize) lives in
 * cli-integration.mjs; this file keeps one focused regression per past defect.
 *
 * CODE-02: every check below must fail when the behaviour it names regresses.
 * "the file exists" / "the file is non-empty" style assertions are not allowed
 * here — they stayed green through real breakage before.
 */

import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { assertFreshBuild, fail, repoRoot, runSuite } from './_shared.mjs';

const execFileAsync = promisify(execFile);
const TEST_FAULT_TOKEN = 'mail-fapiao-helper-test-faults';

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

async function testDataDirLockDoesNotDeleteUnknownStaleLock() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-lock-unknown-'));
  const { acquireDataDirLock, dataDirLockPath } = await import('../../dist/util/dataDirLock.js');
  const lockPath = dataDirLockPath(tmp);
  await mkdir(lockPath, { recursive: true });
  const old = new Date(Date.now() - 20_000);
  await utimes(lockPath, old, old);

  const acquired = acquireDataDirLock(tmp, 'pipeline', 'test-job');
  if (acquired.ok) {
    acquired.lease.release();
    fail('data-dir lock acquired ownership after replacing an unreadable stale lock path');
  }

  const after = await stat(lockPath).catch(() => null);
  if (!after?.isDirectory()) {
    fail('data-dir lock reclamation deleted an unknown stale lock instead of preserving it for retry/manual recovery');
  }
  await rm(lockPath, { recursive: true, force: true });
}

async function testArchivePlanningDoesNotCreatePreJournalOrphan() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-archive-plan-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { stageDocuments } = await import('../../dist/download/downloader.js');
  const { recoverArchiveTransactions } = await import('../../dist/download/archiveJournal.js');
  const { summarizeLibrary } = await import('../../dist/electron/summary.js');
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  const batch = stageDocuments([
    { source: 'invoice.pdf', suggestedName: 'invoice.pdf', data: Buffer.from(PDF_BYTES_B64, 'base64'), format: 'pdf' },
  ], 'prejournal-crash', cfg.paths.invoices, log);

  const planned = batch.plan();
  if (planned.length !== 1 || !planned[0].path.endsWith('0001.pdf')) {
    fail(`archive planning should choose 0001.pdf without touching it, got ${JSON.stringify(planned)}`);
  }

  // Simulates the old kill point between reserve() and beginArchiveTransaction():
  // there is no journal yet. The repair is that planning must not have mutated
  // the final archive directory, so recovery has nothing loose to clean up and
  // the library summary must not expose a false pending invoice row.
  recoverArchiveTransactions(cfg.paths.invoices);
  const archived = (await readdir(cfg.paths.invoices)).filter((name) => isArchivedDocName(name));
  if (archived.length !== 0) {
    fail(`planning before journal creation left loose archive files: ${JSON.stringify(archived)}`);
  }
  const library = summarizeLibrary(cfg, tmp);
  if (library.rows.some((row) => row.filename === '0001.pdf')) {
    fail(`library summary exposed a false row for an unjournaled planning crash: ${JSON.stringify(library.rows)}`);
  }
  batch.dispose();
}

function isArchivedDocName(name) {
  return /\.(pdf|ofd|png|jpe?g|gif|webp|bmp)$/i.test(name);
}

async function testArchiveCollisionAfterJournalPreservesRacedFile() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-archive-collision-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { stageDocuments } = await import('../../dist/download/downloader.js');
  const { beginArchiveTransaction } = await import('../../dist/download/archiveJournal.js');
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  const batch = stageDocuments([
    { source: 'invoice.pdf', suggestedName: 'invoice.pdf', data: Buffer.from(PDF_BYTES_B64, 'base64'), format: 'pdf' },
  ], 'collision-after-journal', cfg.paths.invoices, log);
  const planned = batch.plan();
  const finalPath = planned[0]?.path;
  if (!finalPath) fail(`archive planning returned no final path: ${JSON.stringify(planned)}`);

  const tx = beginArchiveTransaction(cfg.paths.invoices, {
    files: planned,
    csv: [
      { path: cfg.output.csv, baseLength: 0 },
      { path: join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv'), baseLength: 0 },
    ],
  });
  const racedBytes = Buffer.from('%PDF-1.4\n%RACED-WRITER\n%EOF\n');
  await writeFile(finalPath, racedBytes);

  let failedWithExists = false;
  try {
    batch.commit();
  } catch (err) {
    failedWithExists = err?.code === 'EEXIST';
    try {
      tx.rollback();
    } catch (rollbackErr) {
      if (rollbackErr?.code !== 'archive_recovery_failed') throw rollbackErr;
    }
    batch.dispose();
  }
  if (!failedWithExists) fail('archive commit should fail transactionally when a planned final path is created by another writer');
  const after = await readFile(finalPath);
  if (!after.equals(racedBytes)) {
    fail('archive rollback/recovery deleted or overwrote a raced-in file after an EEXIST collision');
  }
}

async function testArchiveLinkFailureLeavesNoFinalFile() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-archive-link-fail-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { stageDocuments } = await import('../../dist/download/downloader.js');
  const { beginArchiveTransaction } = await import('../../dist/download/archiveJournal.js');
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  const batch = stageDocuments([
    { source: 'invoice.pdf', suggestedName: 'invoice.pdf', data: Buffer.from(PDF_BYTES_B64, 'base64'), format: 'pdf' },
  ], 'link-failure', cfg.paths.invoices, log);
  const planned = batch.plan();
  const finalPath = planned[0]?.path;
  if (!finalPath) fail(`archive planning returned no final path: ${JSON.stringify(planned)}`);

  const tx = beginArchiveTransaction(cfg.paths.invoices, {
    files: planned,
    csv: [
      { path: cfg.output.csv, baseLength: 0 },
      { path: join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv'), baseLength: 0 },
    ],
  });
  const originalLinkSync = fs.linkSync;
  fs.linkSync = () => {
    const err = new Error('forced link failure');
    err.code = 'EXDEV';
    throw err;
  };
  let failedWithForcedLink = false;
  try {
    batch.commit();
  } catch (err) {
    failedWithForcedLink = err?.code === 'EXDEV';
    tx.rollback();
  } finally {
    fs.linkSync = originalLinkSync;
    batch.dispose();
  }
  if (!failedWithForcedLink) fail('archive commit should fail on non-EEXIST link errors instead of falling back to copy');
  if (existsSync(finalPath)) fail('archive link failure left an exposed final archive file');
}

async function testArchiveLaterItemFailureRollsBackEarlierHardlink() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-archive-later-fail-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { stageDocuments } = await import('../../dist/download/downloader.js');
  const { beginArchiveTransaction } = await import('../../dist/download/archiveJournal.js');
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  const batch = stageDocuments([
    { source: 'a.pdf', suggestedName: 'a.pdf', data: Buffer.from(PDF_BYTES_B64, 'base64'), format: 'pdf' },
    { source: 'b.pdf', suggestedName: 'b.pdf', data: Buffer.from(PDF_BYTES_B64, 'base64'), format: 'pdf' },
  ], 'later-fail', cfg.paths.invoices, log);
  const planned = batch.plan();
  const firstPath = planned[0]?.path;
  const secondPath = planned[1]?.path;
  if (!firstPath || !secondPath) fail(`archive planning returned incomplete paths: ${JSON.stringify(planned)}`);

  const tx = beginArchiveTransaction(cfg.paths.invoices, {
    files: planned,
    csv: [
      { path: cfg.output.csv, baseLength: 0 },
      { path: join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv'), baseLength: 0 },
    ],
  });
  const racedBytes = Buffer.from('%PDF-1.4\n%SECOND-RACED\n%EOF\n');
  await writeFile(secondPath, racedBytes);

  let failedWithExists = false;
  try {
    batch.commit();
  } catch (err) {
    failedWithExists = err?.code === 'EEXIST';
    try {
      tx.rollback();
    } catch (rollbackErr) {
      if (rollbackErr?.code !== 'archive_recovery_failed') throw rollbackErr;
    }
    batch.dispose();
  }
  if (!failedWithExists) fail('archive commit should fail when a later planned final path already exists');
  if (existsSync(firstPath)) fail('archive rollback did not remove the earlier owned hard-linked file');
  const secondAfter = await readFile(secondPath);
  if (!secondAfter.equals(racedBytes)) fail('archive rollback deleted or overwrote the raced-in later file');
}

async function testPreparedArchiveRecoveryRemovesOwnedHardlink() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-archive-prepared-recover-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { stageDocuments } = await import('../../dist/download/downloader.js');
  const { beginArchiveTransaction, recoverArchiveTransactions } = await import('../../dist/download/archiveJournal.js');
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  const batch = stageDocuments([
    { source: 'invoice.pdf', suggestedName: 'invoice.pdf', data: Buffer.from(PDF_BYTES_B64, 'base64'), format: 'pdf' },
  ], 'prepared-recover', cfg.paths.invoices, log);
  const planned = batch.plan();
  const finalPath = planned[0]?.path;
  if (!finalPath) fail(`archive planning returned no final path: ${JSON.stringify(planned)}`);

  beginArchiveTransaction(cfg.paths.invoices, {
    files: planned,
    csv: [
      { path: cfg.output.csv, baseLength: 0 },
      { path: join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv'), baseLength: 0 },
    ],
  });
  batch.commit();
  if (!existsSync(finalPath)) fail('prepared recovery setup failed to install the final archive file');

  const recovered = recoverArchiveTransactions(cfg.paths.invoices);
  batch.dispose();
  if (recovered.rolledBack !== 1 || existsSync(finalPath)) {
    fail(`prepared archive recovery did not remove its owned hard-linked file: recovered=${JSON.stringify(recovered)} exists=${existsSync(finalPath)}`);
  }
}

async function writeLegacyJournal(invoicesDir, txId, startedAtMs, files, csv = [], overrides = {}) {
  const journalDir = join(invoicesDir, '.journal');
  await mkdir(journalDir, { recursive: true });
  const journalPath = join(journalDir, `${txId}.json`);
  await writeFile(journalPath, `${JSON.stringify({
    txId,
    pid: overrides.pid ?? process.pid,
    startedAtMs,
    stage: overrides.stage ?? 'prepared',
    files,
    csv,
  })}\n`);
  return journalPath;
}

async function withLiveChildPid(body) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await body(child);
  } finally {
    if (!child.killed) child.kill();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
}

async function testLegacyPreparedJournalRemovesOwnedPlaceholderWithoutLibraryRow() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-legacy-placeholder-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { recoverArchiveTransactions } = await import('../../dist/download/archiveJournal.js');
  const { summarizeLibrary } = await import('../../dist/electron/summary.js');
  const placeholder = join(cfg.paths.invoices, '0001.pdf');
  await writeFile(placeholder, '');
  const startedAtMs = Date.now();
  const started = new Date(startedAtMs);
  await utimes(placeholder, started, started);
  const journalPath = await writeLegacyJournal(cfg.paths.invoices, 'legacy-owned-placeholder', startedAtMs, [placeholder]);

  const recovered = recoverArchiveTransactions(cfg.paths.invoices);
  if (recovered.rolledBack !== 1 || recovered.skipped !== 0) {
    fail(`legacy owned placeholder should recover cleanly, got ${JSON.stringify(recovered)}`);
  }
  if (existsSync(placeholder) || existsSync(journalPath)) {
    fail(`legacy owned placeholder recovery left file/journal behind: file=${existsSync(placeholder)} journal=${existsSync(journalPath)}`);
  }
  const library = summarizeLibrary(cfg, tmp);
  if (library.rows.some((row) => row.filename === '0001.pdf')) {
    fail(`legacy placeholder recovery left a false library row: ${JSON.stringify(library.rows)}`);
  }
}

async function testLegacyPreparedJournalPreservesUnprovenFilesAndJournal() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-legacy-unproven-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { recoverArchiveTransactions } = await import('../../dist/download/archiveJournal.js');
  const oldZero = join(cfg.paths.invoices, '0002.pdf');
  const nonzero = join(cfg.paths.invoices, '0003.pdf');
  await writeFile(oldZero, '');
  await writeFile(nonzero, '%PDF-1.4\n%PREEXISTING\n%EOF\n');
  const startedAtMs = Date.now();
  const old = new Date(startedAtMs - 60_000);
  const matching = new Date(startedAtMs);
  await utimes(oldZero, old, old);
  await utimes(nonzero, matching, matching);
  const journalPath = await writeLegacyJournal(cfg.paths.invoices, 'legacy-unproven-files', startedAtMs, [oldZero, nonzero]);

  const recovered = recoverArchiveTransactions(cfg.paths.invoices);
  if (recovered.rolledBack !== 0 || recovered.skipped !== 1) {
    fail(`legacy unproven files should retain the journal as unresolved, got ${JSON.stringify(recovered)}`);
  }
  if (!existsSync(oldZero) || !existsSync(nonzero) || !existsSync(journalPath)) {
    fail(`legacy unproven recovery should preserve files and journal: zero=${existsSync(oldZero)} nonzero=${existsSync(nonzero)} journal=${existsSync(journalPath)}`);
  }
}

async function testUnresolvedJournalDoesNotRetruncateLaterCsvRows() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-unresolved-csv-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  const { recoverArchiveTransactions } = await import('../../dist/download/archiveJournal.js');
  const unproven = join(cfg.paths.invoices, '0004.pdf');
  const ocrCsv = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  await writeFile(unproven, '%PDF-1.4\n%UNPROVEN\n%EOF\n');
  await writeFile(cfg.output.csv, '');
  await writeFile(ocrCsv, '');
  const startedAtMs = Date.now();
  const started = new Date(startedAtMs);
  await utimes(unproven, started, started);
  const journalPath = await writeLegacyJournal(cfg.paths.invoices, 'unresolved-retained-csv', startedAtMs, [unproven], [
    { path: cfg.output.csv, baseLength: 0 },
    { path: ocrCsv, baseLength: 0 },
  ]);

  const first = recoverArchiveTransactions(cfg.paths.invoices);
  if (first.rolledBack !== 0 || first.skipped !== 1 || !existsSync(journalPath)) {
    fail(`unresolved journal should be retained before later CSV writes: ${JSON.stringify(first)}`);
  }
  const flaggedJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  if (flaggedJournal.csvRollbackDisabled !== true) {
    fail(`unresolved journal did not durably disable CSV rollback: ${JSON.stringify(flaggedJournal)}`);
  }

  const laterInvoiceRow = [
    '﻿messageId,date,from,subject,filename,source,contentHash',
    '<later@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,后续发票,9999.pdf,later.pdf,laterhash',
    '',
  ].join('\n');
  const laterOcrRow = [
    '﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash',
    'later-hash,<later@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,后续发票,9999.pdf,later.pdf,pdf,invoice,pending,,laterhash',
    '',
  ].join('\n');
  await writeFile(cfg.output.csv, laterInvoiceRow);
  await writeFile(ocrCsv, laterOcrRow);

  const second = recoverArchiveTransactions(cfg.paths.invoices);
  if (second.rolledBack !== 0 || second.skipped !== 1 || !existsSync(journalPath)) {
    fail(`unresolved journal should remain retained on retry: ${JSON.stringify(second)}`);
  }
  const invoiceAfter = await readFile(cfg.output.csv, 'utf8');
  const ocrAfter = await readFile(ocrCsv, 'utf8');
  if (!invoiceAfter.includes('<later@example.com>') || !ocrAfter.includes('later-hash')) {
    fail(`unresolved retained journal truncated later valid CSV rows:\ninvoice=${invoiceAfter}\nocr=${ocrAfter}`);
  }

  await rm(unproven, { force: true });
  const third = recoverArchiveTransactions(cfg.paths.invoices);
  if (third.rolledBack !== 1 || third.skipped !== 0 || existsSync(journalPath)) {
    fail(`resolved disabled-CSV journal should clean up without truncating CSV: recovered=${JSON.stringify(third)} journal=${existsSync(journalPath)}`);
  }
  const invoiceFinal = await readFile(cfg.output.csv, 'utf8');
  const ocrFinal = await readFile(ocrCsv, 'utf8');
  if (!invoiceFinal.includes('<later@example.com>') || !ocrFinal.includes('later-hash')) {
    fail(`resolved disabled-CSV journal truncated later valid rows:\ninvoice=${invoiceFinal}\nocr=${ocrFinal}`);
  }
}

async function testAutomaticArchiveBlocksWhenCsvRollbackFlagCannotPersist() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-recovery-block-run-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  await writeFile(join(tmp, 'raw', 'pdf.eml'), pdfMail('<blocked-recovery@example.com>'));
  const unproven = join(cfg.paths.invoices, '0004.pdf');
  const ocrCsv = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  await writeFile(unproven, '%PDF-1.4\n%UNPROVEN\n%EOF\n');
  const startedAtMs = Date.now();
  const started = new Date(startedAtMs);
  await utimes(unproven, started, started);
  const journalPath = await writeLegacyJournal(cfg.paths.invoices, 'blocked-recovery-run', startedAtMs, [unproven], [
    { path: cfg.output.csv, baseLength: 0 },
    { path: ocrCsv, baseLength: 0 },
  ], { pid: 99999999 });

  let failed = false;
  try {
    await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'], {
      MFH_TEST_FAULT_TOKEN: TEST_FAULT_TOKEN,
      MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE: '1',
    });
  } catch (err) {
    failed = true;
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    if (!output.includes('archive_journal_recovery_failed')) {
      fail(`unsafe recovery failure should abort the run with recovery error, got:\n${output}`);
    }
  }
  if (!failed) fail('mfh run succeeded even though CSV rollback disable persistence was forced to fail');
  if (existsSync(cfg.output.csv) || existsSync(ocrCsv)) {
    fail(`unsafe recovery failure allowed archive CSV writes: ledger=${existsSync(cfg.output.csv)} ocr=${existsSync(ocrCsv)}`);
  }
  const archived = (await readdir(cfg.paths.invoices)).filter((name) => /^000[0-3]\.pdf$/i.test(name));
  if (archived.length > 0) fail(`unsafe recovery failure installed new archive files: ${JSON.stringify(archived)}`);
  const unflagged = JSON.parse(await readFile(journalPath, 'utf8'));
  if (unflagged.csvRollbackDisabled === true) fail(`forced persistence failure unexpectedly flagged journal: ${JSON.stringify(unflagged)}`);

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);
  const flagged = JSON.parse(await readFile(journalPath, 'utf8'));
  if (flagged.csvRollbackDisabled !== true) fail(`retry did not persist CSV rollback guard: ${JSON.stringify(flagged)}`);
  const ledger = await readFile(cfg.output.csv, 'utf8');
  const queue = await readFile(ocrCsv, 'utf8');
  if (!ledger.includes('<blocked-recovery@example.com>') || !queue.includes('<blocked-recovery@example.com>')) {
    fail(`retry after recovery did not append expected archive rows:\nledger=${ledger}\nqueue=${queue}`);
  }
}

async function testManualArchiveBlocksAndRetriesWhenCsvRollbackFlagCannotPersist() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-recovery-block-manual-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  const source = join(tmp, 'source.pdf');
  await writeFile(source, Buffer.from(PDF_BYTES_B64, 'base64'));
  const unproven = join(cfg.paths.invoices, '0004.pdf');
  const ocrCsv = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  await writeFile(unproven, '%PDF-1.4\n%UNPROVEN\n%EOF\n');
  const startedAtMs = Date.now();
  const started = new Date(startedAtMs);
  await utimes(unproven, started, started);
  const journalPath = await writeLegacyJournal(cfg.paths.invoices, 'blocked-recovery-manual', startedAtMs, [unproven], [
    { path: cfg.output.csv, baseLength: 0 },
    { path: ocrCsv, baseLength: 0 },
  ]);
  const { runManualArchive } = await import('../../dist/electron/manualArchive.js');
  const input = {
    sources: [source],
    invoicesDir: cfg.paths.invoices,
    ledgerCsv: cfg.output.csv,
    ocrPendingCsv: ocrCsv,
    hash: 'manual-recovery-hash',
    pendingRow: {
      messageId: '<manual-recovery@example.com>',
      date: '2026-05-21T03:00:00.000Z',
      from: 'vendor@example.com',
      subject: '手动归档',
    },
    removePendingRow: () => fail('manual archive removed pending row after unsafe recovery failure'),
  };

  const previous = process.env.MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE;
  const previousToken = process.env.MFH_TEST_FAULT_TOKEN;
  process.env.MFH_TEST_FAULT_TOKEN = TEST_FAULT_TOKEN;
  process.env.MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE = '1';
  let threw = false;
  try {
    runManualArchive(input);
  } catch (err) {
    threw = err?.code === 'archive_recovery_failed' || err?.name === 'ArchiveRecoveryError';
  } finally {
    if (previous === undefined) delete process.env.MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE;
    else process.env.MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE = previous;
    if (previousToken === undefined) delete process.env.MFH_TEST_FAULT_TOKEN;
    else process.env.MFH_TEST_FAULT_TOKEN = previousToken;
  }
  if (!threw) fail('manual archive did not throw an archive recovery error when guard persistence failed');
  if (existsSync(cfg.output.csv) || existsSync(ocrCsv) || existsSync(join(cfg.paths.invoices, '0001.pdf'))) {
    fail(`manual archive wrote files/CSVs after unsafe recovery failure: ledger=${existsSync(cfg.output.csv)} ocr=${existsSync(ocrCsv)} file=${existsSync(join(cfg.paths.invoices, '0001.pdf'))}`);
  }
  const unflagged = JSON.parse(await readFile(journalPath, 'utf8'));
  if (unflagged.csvRollbackDisabled === true) fail(`manual forced persistence failure unexpectedly flagged journal: ${JSON.stringify(unflagged)}`);

  const result = runManualArchive({
    ...input,
    removePendingRow: () => 1,
  });
  if (!result.ok || result.files.length !== 1) fail(`manual archive retry did not succeed after recovery retry: ${JSON.stringify(result)}`);
  const flagged = JSON.parse(await readFile(journalPath, 'utf8'));
  if (flagged.csvRollbackDisabled !== true) fail(`manual retry did not persist CSV rollback guard: ${JSON.stringify(flagged)}`);
  const ledger = await readFile(cfg.output.csv, 'utf8');
  const queue = await readFile(ocrCsv, 'utf8');
  if (!ledger.includes('<manual-recovery@example.com>') || !queue.includes('manual-recovery-hash')) {
    fail(`manual retry did not append expected rows:\nledger=${ledger}\nqueue=${queue}`);
  }
}

async function testRollbackTruncateFailureBlocksLaterArchiveRowsAndRetries() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-rollback-block-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  const statePath = join(tmp, 'state.json');
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  await writeFile(join(tmp, 'raw', 'a.eml'), pdfMail('<rollback-a@example.com>'));
  await writeFile(join(tmp, 'raw', 'b.eml'), pdfMail('<rollback-b@example.com>'));

  let failed = false;
  try {
    await runMfh(['run', '--config', configPath, '--state', statePath, '--concurrency', '1'], {
      MFH_TEST_FAULT_TOKEN: TEST_FAULT_TOKEN,
      MFH_TEST_FAIL_AFTER_INVOICE_CSV: '1',
      MFH_TEST_FAIL_CSV_TRUNCATE: '1',
    });
  } catch (err) {
    failed = true;
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    if (!output.includes('archive_journal_recovery_failed')) {
      fail(`rollback truncate failure should abort as archive recovery error, got:\n${output}`);
    }
  }
  if (!failed) fail('mfh run succeeded despite forced rollback truncation failure');
  const retainedJournals = await readdir(join(cfg.paths.invoices, '.journal')).catch(() => []);
  if (retainedJournals.filter((name) => name.endsWith('.json')).length !== 1) {
    fail(`forced rollback truncation failure should retain exactly one journal, got ${JSON.stringify(retainedJournals)}`);
  }
  const ledgerAfterFailure = existsSync(cfg.output.csv) ? await readFile(cfg.output.csv, 'utf8') : '';
  if (ledgerAfterFailure.includes('<rollback-b@example.com>')) {
    fail(`same-process recovery cache allowed later email B to append after retained rollback journal:\n${ledgerAfterFailure}`);
  }

  await runMfh(['run', '--config', configPath, '--state', statePath, '--concurrency', '1']);
  const journalsAfterRetry = await readdir(join(cfg.paths.invoices, '.journal')).catch(() => []);
  if (journalsAfterRetry.some((name) => name.endsWith('.json'))) {
    fail(`retry should recover and remove retained rollback journal, got ${JSON.stringify(journalsAfterRetry)}`);
  }
  const ledger = await readFile(cfg.output.csv, 'utf8');
  if (!ledger.includes('<rollback-a@example.com>') || !ledger.includes('<rollback-b@example.com>')) {
    fail(`retry after rollback recovery should process both emails:\n${ledger}`);
  }
}

async function testOrganizeBlocksWhenArchiveRecoveryCannotPersistGuard() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-organize-recovery-block-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  await writeFile(join(cfg.paths.invoices, '0001.pdf'), Buffer.from(PDF_BYTES_B64, 'base64'));
  await writeFile(cfg.ocr.resultsCsv, [
    '﻿hash,messageId,date,from,subject,filename,source,format,documentType,invoiceType,seller,amount,dateValue,invoiceNo,transport,extractedBy,parserVersion,ocrVendor,status,error,contentHash',
    'organize-hash,<organize-block@example.com>,2026-05-21T04:00:00.000Z,vendor@example.com,整理测试,0001.pdf,source.pdf,pdf,invoice,normal,测试公司,12.34,2026-05-21,INV-1,mock,mock,1,mock,success,,organize-content',
    '',
  ].join('\n'));
  const unproven = join(cfg.paths.invoices, '0004.pdf');
  const ocrCsv = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  await writeFile(unproven, '%PDF-1.4\n%UNPROVEN\n%EOF\n');
  const startedAtMs = Date.now();
  const started = new Date(startedAtMs);
  await utimes(unproven, started, started);
  await writeLegacyJournal(cfg.paths.invoices, 'blocked-recovery-organize', startedAtMs, [unproven], [
    { path: cfg.output.csv, baseLength: 0 },
    { path: ocrCsv, baseLength: 0 },
  ], { pid: 99999999 });

  let failed = false;
  try {
    await runMfh(['organize', '--config', configPath, '--apply-rename'], {
      MFH_TEST_FAULT_TOKEN: TEST_FAULT_TOKEN,
      MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE: '1',
    });
  } catch (err) {
    failed = true;
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    if (!output.includes('archive_journal_recovery_failed')) {
      fail(`organize recovery gate should fail with recovery error, got:\n${output}`);
    }
  }
  if (!failed) fail('mfh organize succeeded even though archive recovery guard persistence failed');
  if (existsSync(join(cfg.rename.organizedDir, 'organize-results.csv'))) {
    fail('organize wrote audit CSV after archive recovery gate failure');
  }
  const organizedFiles = await readdir(cfg.rename.organizedDir).catch(() => []);
  if (organizedFiles.some((name) => name.toLowerCase().endsWith('.pdf'))) {
    fail(`organize copied files after archive recovery gate failure: ${JSON.stringify(organizedFiles)}`);
  }
}

async function testAutomaticArchiveDisposesStagingWhenJournalCreationFails() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-begin-journal-fail-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  await writeFile(join(tmp, 'raw', 'pdf.eml'), pdfMail('<begin-journal-fail@example.com>'));

  await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'], {
    MFH_TEST_FAULT_TOKEN: TEST_FAULT_TOKEN,
    MFH_TEST_FAIL_BEGIN_ARCHIVE_TRANSACTION: '1',
  });

  const stagingRoot = join(cfg.paths.invoices, '.staging');
  const stagingEntries = await readdir(stagingRoot, { recursive: true }).catch(() => []);
  if (stagingEntries.length > 0) {
    fail(`journal creation failure left staged archive artifacts behind: ${JSON.stringify(stagingEntries)}`);
  }
  const archived = (await readdir(cfg.paths.invoices)).filter((name) => /^\d{4}\.(pdf|ofd|png|jpe?g|gif|webp|bmp)$/i.test(name));
  if (archived.length > 0) fail(`journal creation failure installed final archive files: ${JSON.stringify(archived)}`);
}

async function testManualArchiveRollbackFailurePropagatesRecoveryError() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-manual-rollback-fail-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  const source = join(tmp, 'source.pdf');
  await writeFile(source, Buffer.from(PDF_BYTES_B64, 'base64'));
  const { runManualArchive } = await import('../../dist/electron/manualArchive.js');
  const previous = process.env.MFH_TEST_FAIL_CSV_TRUNCATE;
  const previousManual = process.env.MFH_TEST_FAIL_AFTER_MANUAL_QUEUE_CSV;
  const previousToken = process.env.MFH_TEST_FAULT_TOKEN;
  process.env.MFH_TEST_FAULT_TOKEN = TEST_FAULT_TOKEN;
  process.env.MFH_TEST_FAIL_CSV_TRUNCATE = '1';
  process.env.MFH_TEST_FAIL_AFTER_MANUAL_QUEUE_CSV = '1';
  let threw = false;
  try {
    runManualArchive({
      sources: [source],
      invoicesDir: cfg.paths.invoices,
      ledgerCsv: cfg.output.csv,
      ocrPendingCsv: join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv'),
      hash: 'manual-rollback-fail',
      pendingRow: {
        messageId: '<manual-rollback-fail@example.com>',
        date: '2026-05-21T05:00:00.000Z',
        from: 'vendor@example.com',
        subject: '手动回滚失败',
      },
      removePendingRow: () => fail('manual archive removed pending row after rollback recovery failure'),
    });
  } catch (err) {
    threw = err?.code === 'archive_recovery_failed' || err?.name === 'ArchiveRecoveryError';
  } finally {
    if (previous === undefined) delete process.env.MFH_TEST_FAIL_CSV_TRUNCATE;
    else process.env.MFH_TEST_FAIL_CSV_TRUNCATE = previous;
    if (previousManual === undefined) delete process.env.MFH_TEST_FAIL_AFTER_MANUAL_QUEUE_CSV;
    else process.env.MFH_TEST_FAIL_AFTER_MANUAL_QUEUE_CSV = previousManual;
    if (previousToken === undefined) delete process.env.MFH_TEST_FAULT_TOKEN;
    else process.env.MFH_TEST_FAULT_TOKEN = previousToken;
  }
  if (!threw) fail('manual archive rollback failure was hidden instead of propagating ArchiveRecoveryError');
  const journals = await readdir(join(cfg.paths.invoices, '.journal')).catch(() => []);
  if (!journals.some((name) => name.endsWith('.json'))) fail(`manual rollback failure should retain recovery journal, got ${JSON.stringify(journals)}`);
}

async function testFaultInjectionRequiresToken() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-fault-token-'));
  const { cfg } = await writeConfig(tmp);
  await mkdir(cfg.paths.invoices, { recursive: true });
  const { beginArchiveTransaction } = await import('../../dist/download/archiveJournal.js');
  const previous = process.env.MFH_TEST_FAIL_BEGIN_ARCHIVE_TRANSACTION;
  const previousToken = process.env.MFH_TEST_FAULT_TOKEN;
  delete process.env.MFH_TEST_FAULT_TOKEN;
  process.env.MFH_TEST_FAIL_BEGIN_ARCHIVE_TRANSACTION = '1';
  try {
    const tx = beginArchiveTransaction(cfg.paths.invoices, { files: [], csv: [] });
    tx.commit();
  } catch (err) {
    fail(`fault env without token should not affect runtime behavior: ${err?.message ?? err}`);
  } finally {
    if (previous === undefined) delete process.env.MFH_TEST_FAIL_BEGIN_ARCHIVE_TRANSACTION;
    else process.env.MFH_TEST_FAIL_BEGIN_ARCHIVE_TRANSACTION = previous;
    if (previousToken === undefined) delete process.env.MFH_TEST_FAULT_TOKEN;
    else process.env.MFH_TEST_FAULT_TOKEN = previousToken;
  }
}

async function testLivePidJournalBlocksStrictMutationAndRetriesAfterExit() {
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-live-pid-journal-'));
  const { cfg, path: configPath } = await writeConfig(tmp);
  const statePath = join(tmp, 'state.json');
  await mkdir(join(tmp, 'raw'), { recursive: true });
  await mkdir(cfg.paths.invoices, { recursive: true });
  await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
  await mkdir(join(tmp, 'custom'), { recursive: true });
  await writeFile(join(tmp, 'raw', 'pdf.eml'), pdfMail('<live-pid-block@example.com>'));
  const finalPath = join(cfg.paths.invoices, '0098.pdf');
  const ocrCsv = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  await writeFile(finalPath, '%PDF-1.4\n%LIVE-PID-JOURNAL\n%EOF\n');
  const startedAtMs = Date.now();

  await withLiveChildPid(async (child) => {
    const journalPath = await writeLegacyJournal(cfg.paths.invoices, 'live-pid-block', startedAtMs, [finalPath], [
      { path: cfg.output.csv, baseLength: 0 },
      { path: ocrCsv, baseLength: 0 },
    ], {
      pid: child.pid,
      stage: 'files-installed',
    });
    const raw = JSON.parse(await readFile(journalPath, 'utf8'));
    raw.installed = [{ path: finalPath, size: (await stat(finalPath)).size, mtimeMs: (await stat(finalPath)).mtimeMs }];
    await writeFile(journalPath, `${JSON.stringify(raw)}\n`);

    const { assertArchiveTransactionsRecovered, recoverArchiveTransactions } = await import('../../dist/download/archiveJournal.js');
    const nonStrict = recoverArchiveTransactions(cfg.paths.invoices);
    if (nonStrict.rolledBack !== 0 || nonStrict.skipped !== 1) {
      fail(`non-strict startup recovery should skip live PID journal, got ${JSON.stringify(nonStrict)}`);
    }
    let strictBlocked = false;
    try {
      assertArchiveTransactionsRecovered(cfg.paths.invoices);
    } catch (err) {
      strictBlocked = err?.code === 'archive_recovery_failed' || err?.name === 'ArchiveRecoveryError';
    }
    if (!strictBlocked) fail('strict recovery assertion did not block unrelated live-PID journal');

    let runBlocked = false;
    try {
      await runMfh(['run', '--config', configPath, '--state', statePath, '--concurrency', '1']);
    } catch (err) {
      runBlocked = true;
      const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      if (!output.includes('archive_journal_recovery_failed')) {
        fail(`CLI run should block on live-PID journal before writes, got:\n${output}`);
      }
    }
    if (!runBlocked) fail('CLI run wrote despite unrelated live-PID journal');
    if (existsSync(cfg.output.csv) || existsSync(ocrCsv)) {
      fail(`live-PID journal gate allowed archive CSV writes: ledger=${existsSync(cfg.output.csv)} ocr=${existsSync(ocrCsv)}`);
    }

    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  });

  await runMfh(['run', '--config', configPath, '--state', statePath, '--concurrency', '1']);
  if (existsSync(finalPath)) fail('retry recovery did not remove file from dead-PID retained journal');
  const ledger = await readFile(cfg.output.csv, 'utf8');
  if (!ledger.includes('<live-pid-block@example.com>')) {
    fail(`retry after live-PID exit did not process blocked email:\n${ledger}`);
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
  await testDataDirLockDoesNotDeleteUnknownStaleLock();
  await testArchivePlanningDoesNotCreatePreJournalOrphan();
  await testArchiveCollisionAfterJournalPreservesRacedFile();
  await testArchiveLinkFailureLeavesNoFinalFile();
  await testArchiveLaterItemFailureRollsBackEarlierHardlink();
  await testPreparedArchiveRecoveryRemovesOwnedHardlink();
  await testLegacyPreparedJournalRemovesOwnedPlaceholderWithoutLibraryRow();
  await testLegacyPreparedJournalPreservesUnprovenFilesAndJournal();
  await testUnresolvedJournalDoesNotRetruncateLaterCsvRows();
  await testAutomaticArchiveBlocksWhenCsvRollbackFlagCannotPersist();
  await testManualArchiveBlocksAndRetriesWhenCsvRollbackFlagCannotPersist();
  await testRollbackTruncateFailureBlocksLaterArchiveRowsAndRetries();
  await testOrganizeBlocksWhenArchiveRecoveryCannotPersistGuard();
  await testAutomaticArchiveDisposesStagingWhenJournalCreationFails();
  await testManualArchiveRollbackFailurePropagatesRecoveryError();
  await testFaultInjectionRequiresToken();
  await testLivePidJournalBlocksStrictMutationAndRetriesAfterExit();
}, { timeoutMs: 4 * 60 * 1000 });
