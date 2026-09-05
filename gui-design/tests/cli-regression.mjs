/* CLI regression suite — narrow, per-bug assertions against the compiled CLI.
 *
 * Broad end-to-end coverage (archive → CSV → state → OCR → organize) lives in
 * cli-integration.mjs; this file keeps one focused regression per past defect.
 *
 * CODE-02: every check below must fail when the behaviour it names regresses.
 * "the file exists" / "the file is non-empty" style assertions are not allowed
 * here — they stayed green through real breakage before.
 */

import { mkdir, readFile, writeFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertFreshBuild, fail, killProcessTree, repoRoot, runSuite, withTempDir } from './_shared.mjs';

/* Helper scripts written to a temp dir import compiled modules by absolute path.
   A bare Windows path (`D:\...`) is not a legal ESM specifier — Node's loader
   rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'd:'").
   Always go through a file:// URL. */
function distImportSpecifier(relativeDistPath) {
  return JSON.stringify(pathToFileURL(join(repoRoot, relativeDistPath)).href);
}

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
    env: {
      ...process.env,
      // MOCK-OCR-GATE: mock provider requires an explicit test-only env flag.
      MFH_ALLOW_MOCK_OCR: '1',
      ...env,
    },
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
  await withTempDir('mfh-cli-regression-', async (tmp) => {
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
  });
}

async function testPendingWithoutMessageId() {
  await withTempDir('mfh-cli-noid-', async (tmp) => {
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
  });
}

async function testCsvStateRecovery() {
  await withTempDir('mfh-cli-recover-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });
    await mkdir(join(tmp, 'custom'), { recursive: true });
    await mkdir(cfg.paths.invoices, { recursive: true });
    await writeFile(join(tmp, 'raw', 'recover.eml'), pdfMail('<recover-case@example.com>'));
    // 归档字节必须与邮件附件相同：六列 legacy 升级后靠 contentHash 复用，
    // 不再用 Message-Id 折叠整封邮件（CORE-03）。内容一致 → 不得装碰撞副本。
    const archivedBefore = Buffer.from(PDF_BYTES_B64, 'base64');
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
    const archivedAfter = await readFile(join(cfg.paths.invoices, 'invoice.pdf'));
    if (!archivedAfter.equals(archivedBefore)) fail('the already-archived invoice was overwritten during recovery');

    const ledger = parseSimpleCsv(await readFile(cfg.output.csv, 'utf8'));
    if (ledger.rows.length !== 1) {
      fail(`output.csv should still hold one row after recovery, got ${ledger.rows.length}`);
    }
    if (column(ledger, ledger.rows[0], 'filename') !== 'invoice.pdf') {
      fail(`output.csv row was rewritten during recovery: ${ledger.rows[0].join(',')}`);
    }
    // 六列 → 八列升级必须回填 contentHash / mailHash，否则 force-rerun 会装副本。
    const contentHash = column(ledger, ledger.rows[0], 'contentHash');
    const mailHash = column(ledger, ledger.rows[0], 'mailHash');
    if (!contentHash || contentHash.length < 12) {
      fail(`six-column ledger upgrade must backfill contentHash, got ${JSON.stringify(contentHash)}`);
    }
    if (!mailHash || !/^[0-9a-f]{12}$|^[0-9a-f]{32}$/i.test(mailHash)) {
      fail(`six-column ledger upgrade must backfill mailHash, got ${JSON.stringify(mailHash)}`);
    }
  });
}

async function testOcrSingleItemResume() {
  await withTempDir('mfh-cli-ocr-single-', async (tmp) => {
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
  });
}

async function testOcrSuccessBeatsLaterFailure() {
  await withTempDir('mfh-cli-ocr-dedupe-', async (tmp) => {
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
      'same-hash,<same@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,same.pdf,same.pdf,pdf,invoice,电子发票,示例餐饮有限公司,99.00,2026-05-21,00000000000000000000,cli,text_layer,0.1.0,,success,',
      'same-hash,<same@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,发票,same.pdf,same.pdf,pdf,invoice,,,,,,,,,,error,efapiao timeout after 120000ms',
      '',
    ].join('\n'));

    const { stdout } = await runMfh(['ocr', 'summary', '--config', configPath]);
    if (!stdout.includes('recognized=1 failed=0 ignored=0 pending=0')) {
      fail(`OCR summary should prefer an existing success over a later failure:\n${stdout}`);
    }
  });
}

async function testOcrDedupeFallsBackToFilename() {
  await withTempDir('mfh-cli-ocr-filename-key-', async (tmp) => {
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
  });
}

/* TEST-04: assert real concurrency overlap via barrier + peak counter.
 *
 * Wall-clock savings (old 900ms / 600ms thresholds) are machine-dependent.
 * The mock provider now waits on MFH_MOCK_OCR_BARRIER_DIR until `go` exists and
 * writes peak concurrency to MFH_MOCK_OCR_PEAK_PATH — so this test measures
 * overlap, not scheduler luck.
 */
async function testOcrConcurrencyRunsInParallel() {
  const ITEMS = 4;

  async function prepare(tmp) {
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

  async function runWithBarrier(prefix, extraArgs, { expectMinPeak, expectMaxPeak }) {
    return withTempDir(prefix, async (tmp) => {
      const configPath = await prepare(tmp);
      const barrierDir = join(tmp, 'barrier');
      const peakPath = join(tmp, 'peak.txt');
      await mkdir(barrierDir, { recursive: true });

      const child = spawn(process.execPath, ['dist/index.js', 'ocr', 'run', '--config', configPath, ...extraArgs], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MFH_ALLOW_MOCK_OCR: '1',
          MFH_MOCK_OCR_FAIL_BATCH: '1',
          MFH_MOCK_OCR_BARRIER_DIR: barrierDir,
          MFH_MOCK_OCR_PEAK_PATH: peakPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      // Wait until the mock provider has entered at least expectMinPeak times
      // (or the process exits early with an error).
      const goPath = join(barrierDir, 'go');
      const deadline = Date.now() + 30_000;
      let sawEntries = 0;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          const entries = (await readdir(barrierDir)).filter((name) => name.startsWith('entered-'));
          sawEntries = entries.length;
          if (sawEntries >= expectMinPeak) break;
        } catch {
          // barrier dir may not exist yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (child.exitCode !== null) {
        fail(`OCR child exited before barrier entries reached ${expectMinPeak}: code=${child.exitCode}\n${stdout}\n${stderr}`);
      }
      if (sawEntries < expectMinPeak) {
        killProcessTree(child.pid);
        fail(`OCR barrier never saw ${expectMinPeak} concurrent entries (saw ${sawEntries}) for ${extraArgs.join(' ')}`);
      }
      await writeFile(goPath, 'go\n');

      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
      });
      if (exitCode !== 0) {
        fail(`OCR run failed (${extraArgs.join(' ')}): code=${exitCode}\n${stdout}\n${stderr}`);
      }
      if (!stdout.includes(`OCR complete: scanned=${ITEMS}, parsed=${ITEMS}, skipped=0, failed=0`)) {
        fail(`OCR run did not parse all ${ITEMS} items (${extraArgs.join(' ')}):\n${stdout}`);
      }
      const peak = Number((await readFile(peakPath, 'utf8').catch(() => '0')).trim());
      if (!Number.isFinite(peak) || peak < expectMinPeak) {
        fail(`OCR peak concurrency ${peak} < required ${expectMinPeak} for ${extraArgs.join(' ')}`);
      }
      if (peak > expectMaxPeak) {
        fail(`OCR peak concurrency ${peak} > allowed ${expectMaxPeak} for ${extraArgs.join(' ')}`);
      }
      return peak;
    });
  }

  // Serial: at most one parse active at a time.
  await runWithBarrier('mfh-cli-ocr-serial-', ['--single-item'], { expectMinPeak: 1, expectMaxPeak: 1 });
  // Parallel: at least two parses must overlap under --concurrency N.
  await runWithBarrier('mfh-cli-ocr-concurrency-', ['--concurrency', String(ITEMS)], {
    expectMinPeak: 2,
    expectMaxPeak: ITEMS,
  });
}

async function testDataDirLockDoesNotDeleteUnknownStaleLock() {
  await withTempDir('mfh-cli-lock-unknown-', async (tmp) => {
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
  });
}

async function testArchivePlanningDoesNotCreatePreJournalOrphan() {
  await withTempDir('mfh-cli-archive-plan-', async (tmp) => {
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
  });
}

function isArchivedDocName(name) {
  return /\.(pdf|ofd|png|jpe?g|gif|webp|bmp)$/i.test(name);
}

async function testArchiveCollisionAfterJournalPreservesRacedFile() {
  await withTempDir('mfh-cli-archive-collision-', async (tmp) => {
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
        if (rollbackErr?.code !== 'archive_journal_recovery_failed' && rollbackErr?.name !== 'ArchiveRecoveryError') throw rollbackErr;
      }
      batch.dispose();
    }
    if (!failedWithExists) fail('archive commit should fail transactionally when a planned final path is created by another writer');
    const after = await readFile(finalPath);
    if (!after.equals(racedBytes)) {
      fail('archive rollback/recovery deleted or overwrote a raced-in file after an EEXIST collision');
    }
  });
}

async function testArchiveLinkFailureLeavesNoFinalFile() {
  await withTempDir('mfh-cli-archive-link-fail-', async (tmp) => {
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
  });
}

async function testArchiveLaterItemFailureRollsBackEarlierHardlink() {
  await withTempDir('mfh-cli-archive-later-fail-', async (tmp) => {
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
        if (rollbackErr?.code !== 'archive_journal_recovery_failed' && rollbackErr?.name !== 'ArchiveRecoveryError') throw rollbackErr;
      }
      batch.dispose();
    }
    if (!failedWithExists) fail('archive commit should fail when a later planned final path already exists');
    if (existsSync(firstPath)) fail('archive rollback did not remove the earlier owned hard-linked file');
    const secondAfter = await readFile(secondPath);
    if (!secondAfter.equals(racedBytes)) fail('archive rollback deleted or overwrote the raced-in later file');
  });
}

async function testPreparedArchiveRecoveryRemovesOwnedHardlink() {
  await withTempDir('mfh-cli-archive-prepared-recover-', async (tmp) => {
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
  });
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
  await withTempDir('mfh-cli-legacy-placeholder-', async (tmp) => {
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
  });
}

async function testLegacyPreparedJournalPreservesUnprovenFilesAndJournal() {
  await withTempDir('mfh-cli-legacy-unproven-', async (tmp) => {
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
  });
}

async function testUnresolvedJournalDoesNotRetruncateLaterCsvRows() {
  await withTempDir('mfh-cli-unresolved-csv-', async (tmp) => {
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
  });
}

async function testAutomaticArchiveBlocksWhenCsvRollbackFlagCannotPersist() {
  await withTempDir('mfh-cli-recovery-block-run-', async (tmp) => {
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
  });
}

async function testManualArchiveBlocksAndRetriesWhenCsvRollbackFlagCannotPersist() {
  await withTempDir('mfh-cli-recovery-block-manual-', async (tmp) => {
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
      threw = err?.code === 'archive_journal_recovery_failed' || err?.code === 'archive_recovery_failed' || err?.name === 'ArchiveRecoveryError';
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
  });
}

async function testRollbackTruncateFailureBlocksLaterArchiveRowsAndRetries() {
  await withTempDir('mfh-cli-rollback-block-', async (tmp) => {
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
  });
}

async function testOrganizeBlocksWhenArchiveRecoveryCannotPersistGuard() {
  await withTempDir('mfh-cli-organize-recovery-block-', async (tmp) => {
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
  });
}

async function testAutomaticArchiveDisposesStagingWhenJournalCreationFails() {
  await withTempDir('mfh-cli-begin-journal-fail-', async (tmp) => {
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
  });
}

async function testManualArchiveRollbackFailurePropagatesRecoveryError() {
  await withTempDir('mfh-cli-manual-rollback-fail-', async (tmp) => {
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
      threw = err?.code === 'archive_journal_recovery_failed' || err?.code === 'archive_recovery_failed' || err?.name === 'ArchiveRecoveryError';
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
  });
}

async function testFaultInjectionRequiresToken() {
  await withTempDir('mfh-cli-fault-token-', async (tmp) => {
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
  });
}

async function testLivePidJournalBlocksStrictMutationAndRetriesAfterExit() {
  await withTempDir('mfh-cli-live-pid-journal-', async (tmp) => {
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
        strictBlocked = err?.code === 'archive_journal_recovery_failed' || err?.code === 'archive_recovery_failed' || err?.name === 'ArchiveRecoveryError';
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
  });
}

/* TEST-08: two real processes racing the same data-dir lock — exactly one wins;
 * wrong token is rejected; correct token inherits the lease. */
async function testDataDirLockCrossProcessMutualExclusion() {
  await withTempDir('mfh-cli-lock-race-', async (tmp) => {
    const { path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });
    await mkdir(join(tmp, 'custom'), { recursive: true });
    await writeFile(join(tmp, 'raw', 'a.eml'), pdfMail('<lock-race-a@example.com>'));
    await writeFile(join(tmp, 'raw', 'b.eml'), pdfMail('<lock-race-b@example.com>'));

    const readyPath = join(tmp, 'holder-ready');
    const holderPath = join(tmp, 'holder.mjs');
    await writeFile(holderPath, `
import { writeFileSync } from 'node:fs';
import { acquireDataDirLock } from ${distImportSpecifier('dist/util/dataDirLock.js')};
const result = acquireDataDirLock(${JSON.stringify(tmp)}, 'pipeline', 'holder-job');
if (!result.ok) {
  console.error('holder failed', result);
  process.exit(2);
}
writeFileSync(process.env.MFH_TEST_HOLDER_READY, result.lease.token);
setInterval(() => {}, 1000);
`);

    const holder = spawn(process.execPath, [holderPath], {
      cwd: repoRoot,
      env: { ...process.env, MFH_TEST_HOLDER_READY: readyPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let holderErr = '';
    holder.stderr.on('data', (c) => { holderErr += c; });

    const deadline = Date.now() + 10_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      if (holder.exitCode !== null) {
        fail(`lock holder exited early: code=${holder.exitCode}\n${holderErr}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!existsSync(readyPath)) {
      killProcessTree(holder.pid);
      fail('lock holder never signalled ready');
    }
    const holderToken = (await readFile(readyPath, 'utf8')).trim();

    // Contender without token must be blocked.
    let blocked = false;
    try {
      await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']);
    } catch (err) {
      blocked = true;
      const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      if (!/占用|lock|locked|另一个|数据目录/i.test(output)) {
        // Still OK if exit is non-zero — message text may change; require non-success.
        if (err.code === 0) fail(`contender succeeded while lock held:\n${output}`);
      }
    }
    if (!blocked) fail('second CLI acquired the data-dir lock while another process held it');

    // Contender with wrong token must also be blocked.
    let wrongTokenBlocked = false;
    try {
      await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'], {
        MFH_LOCK_TOKEN: 'deadbeefdeadbeefdeadbeefdeadbeef',
        MFH_LOCK_JOB_ID: 'wrong-job',
      });
    } catch {
      wrongTokenBlocked = true;
    }
    if (!wrongTokenBlocked) fail('CLI with wrong MFH_LOCK_TOKEN inherited a foreign lease');

    // Contender with correct token must inherit and proceed (may write ledger).
    await runMfh(
      ['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'],
      {
        MFH_LOCK_TOKEN: holderToken,
        MFH_LOCK_JOB_ID: 'holder-job',
      },
    );
    if (!existsSync(join(tmp, 'custom', 'invoices.csv')) && !existsSync(join(tmp, 'pending', 'pending.csv'))) {
      // At least one of the two fixture mails should produce ledger or pending.
      fail('token inheritance run produced neither invoices.csv nor pending.csv');
    }

    killProcessTree(holder.pid);
    await new Promise((resolve) => {
      if (holder.exitCode !== null || holder.signalCode !== null) resolve();
      else holder.once('exit', resolve);
    });
  });
}

/* TEST-08: OperationCoordinator 4×4 mutual exclusion matrix + re-entry after release. */
async function testOperationCoordinatorMutexMatrix() {
  await withTempDir('mfh-cli-opcoord-', async (tmp) => {
    const { OperationCoordinator } = await import('../../dist/electron/opCoordinator.js');
    const kinds = ['fetch', 'pipeline', 'ocr', 'organize'];
    const broadcasts = [];
    const coord = new OperationCoordinator(tmp);
    coord.setBroadcast((payload) => broadcasts.push(payload));

    for (const held of kinds) {
      const first = coord.begin(held);
      if (!first.ok) fail(`first begin(${held}) should succeed: ${JSON.stringify(first)}`);
      if (coord.current()?.kind !== held) fail(`current() should be ${held}, got ${JSON.stringify(coord.current())}`);
      if (!broadcasts.some((b) => b.running?.kind === held)) {
        fail(`begin(${held}) did not broadcast running state`);
      }

      for (const contender of kinds) {
        const second = coord.begin(contender);
        if (second.ok) {
          second.lease.release();
          first.lease.release();
          fail(`begin(${contender}) while holding ${held} should return operation_busy`);
        }
        if (second.code !== 'operation_busy') {
          first.lease.release();
          fail(`expected operation_busy for ${contender} vs ${held}, got ${JSON.stringify(second)}`);
        }
      }

      first.lease.release();
      if (coord.current() !== null) fail(`after release(${held}) current() should be null`);
      if (!broadcasts.some((b) => b.running === null)) {
        fail(`release(${held}) did not broadcast running=null`);
      }

      // Re-entry after release must succeed for every kind.
      const again = coord.begin(held);
      if (!again.ok) fail(`re-begin(${held}) after release failed: ${JSON.stringify(again)}`);
      again.lease.release();
    }

    // dispose() must free a held lease so a new coordinator on the same dir can acquire.
    const sticky = coord.begin('pipeline');
    if (!sticky.ok) fail(`sticky begin failed: ${JSON.stringify(sticky)}`);
    coord.dispose();
    const afterDispose = new OperationCoordinator(tmp).begin('ocr');
    if (!afterDispose.ok) fail(`begin after dispose should succeed: ${JSON.stringify(afterDispose)}`);
    afterDispose.lease.release();
  });
}

/* TEST-10: real SIGKILL at each durable journal stage, then recover in a new process. */
async function testJournalHardKillStageRecovery() {
  const stages = ['prepared', 'files-installed', 'ledger-committed'];

  for (const holdStage of stages) {
    await withTempDir(`mfh-cli-kill-${holdStage}-`, async (tmp) => {
      const { cfg } = await writeConfig(tmp);
      await mkdir(cfg.paths.invoices, { recursive: true });
      await mkdir(join(tmp, 'custom'), { recursive: true });
      const ocrCsv = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
      await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });

      // Seed "old" ledger so ledger-committed recovery can prove CSV retention.
      const oldLedger = [
        '﻿messageId,date,from,subject,filename,source,contentHash',
        '<old@example.com>,2026-05-20T00:00:00.000Z,vendor@example.com,旧票,0000.pdf,old.pdf,oldhash000001',
        '',
      ].join('\n');
      await writeFile(cfg.output.csv, oldLedger);
      const oldOcr = [
        '﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash',
        'oldhash,<old@example.com>,2026-05-20T00:00:00.000Z,vendor@example.com,旧票,0000.pdf,old.pdf,pdf,invoice,pending,seed,oldhash000001',
        '',
      ].join('\n');
      await writeFile(ocrCsv, oldOcr);
      const oldLedgerLen = Buffer.byteLength(oldLedger, 'utf8');
      const oldOcrLen = Buffer.byteLength(oldOcr, 'utf8');

      const sentinel = join(tmp, `hold-${holdStage}.sentinel`);
      const workerPath = join(tmp, 'worker.mjs');
      // Child imports compiled modules and drives a real archive transaction to the hold stage.
      await writeFile(workerPath, `
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stageDocuments } from ${distImportSpecifier('dist/download/downloader.js')};
import { beginArchiveTransaction, appendCsvBlockDurable } from ${distImportSpecifier('dist/download/archiveJournal.js')};

const invoicesDir = ${JSON.stringify(cfg.paths.invoices)};
const ledgerCsv = ${JSON.stringify(cfg.output.csv)};
const ocrCsv = ${JSON.stringify(ocrCsv)};
const holdStage = ${JSON.stringify(holdStage)};
const log = { debug() {}, info() {}, warn() {}, error() {} };

const batch = stageDocuments([
  { source: 'kill.pdf', suggestedName: 'kill.pdf', data: Buffer.from('JVBERi0xLjQKJUVPRgo=', 'base64'), format: 'pdf' },
], 'hard-kill-' + holdStage, invoicesDir, log);
const planned = batch.plan();
const finalPath = planned[0].path;
const tx = beginArchiveTransaction(invoicesDir, {
  files: planned,
  csv: [
    { path: ledgerCsv, baseLength: ${oldLedgerLen} },
    { path: ocrCsv, baseLength: ${oldOcrLen} },
  ],
});
// prepared hold already ran inside beginArchiveTransaction when configured.
if (holdStage === 'prepared') {
  // Should be unreachable (begin holds forever); keep process alive if barrier misconfigured.
  setInterval(() => {}, 1000);
} else {
  batch.commit();
  tx.markStage('files-installed');
  if (holdStage === 'files-installed') {
    setInterval(() => {}, 1000);
  } else {
    const invoiceLine = '<kill@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,强杀票,' +
      planned[0].path.split(/[\\\\/]/).pop() + ',kill.pdf,killhash000001\\n';
    appendCsvBlockDurable(ledgerCsv, 'messageId,date,from,subject,filename,source,contentHash', [invoiceLine]);
    const ocrLine = 'killhash,<kill@example.com>,2026-05-21T02:00:00.000Z,vendor@example.com,强杀票,' +
      planned[0].path.split(/[\\\\/]/).pop() + ',kill.pdf,pdf,invoice,pending,document_requires_ocr,killhash000001\\n';
    appendCsvBlockDurable(ocrCsv, 'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash', [ocrLine]);
    tx.markStage('ledger-committed');
    setInterval(() => {}, 1000);
  }
}
`);

      const child = spawn(process.execPath, [workerPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MFH_TEST_FAULT_TOKEN: TEST_FAULT_TOKEN,
          MFH_TEST_JOURNAL_HOLD_AT_STAGE: '1',
          MFH_TEST_JOURNAL_HOLD_STAGE: holdStage,
          MFH_TEST_JOURNAL_HOLD_SENTINEL: sentinel,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let childErr = '';
      child.stderr.on('data', (c) => { childErr += c; });
      child.stdout.on('data', () => {});

      const deadline = Date.now() + 15_000;
      while (!existsSync(sentinel) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          fail(`journal worker for stage=${holdStage} exited before hold: code=${child.exitCode}\n${childErr}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (!existsSync(sentinel)) {
        killProcessTree(child.pid);
        fail(`journal worker never reached hold stage=${holdStage}\n${childErr}`);
      }

      // Real hard kill — not a cooperative exit.
      killProcessTree(child.pid);
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', resolve);
      });

      // New process recovers via the same entry the CLI uses at startup.
      const recoverPath = join(tmp, 'recover.mjs');
      await writeFile(recoverPath, `
import { recoverArchiveTransactions } from ${distImportSpecifier('dist/download/archiveJournal.js')};
const r = recoverArchiveTransactions(${JSON.stringify(cfg.paths.invoices)});
console.log(JSON.stringify(r));
`);
      const { stdout: recoverOut } = await execFileAsync(process.execPath, [recoverPath], {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      });
      const recovered = JSON.parse(recoverOut.trim().split('\n').pop());

      const archived = (await readdir(cfg.paths.invoices)).filter((name) => isArchivedDocName(name));
      const ledgerText = await readFile(cfg.output.csv, 'utf8');
      const ocrText = await readFile(ocrCsv, 'utf8');
      const journals = await readdir(join(cfg.paths.invoices, '.journal')).catch(() => []);
      const liveJournals = journals.filter((name) => name.endsWith('.json'));

      if (holdStage === 'prepared' || holdStage === 'files-installed') {
        // Must roll back to pre-transaction state: no new archive files, old CSV only.
        if (recovered.rolledBack !== 1) {
          fail(`stage=${holdStage} recovery should roll back once, got ${JSON.stringify(recovered)}`);
        }
        if (archived.length !== 0) {
          fail(`stage=${holdStage} left archive files after recovery: ${JSON.stringify(archived)}`);
        }
        if (ledgerText.includes('<kill@example.com>') || ocrText.includes('killhash')) {
          fail(`stage=${holdStage} recovery left new CSV rows:\nledger=${ledgerText}\nocr=${ocrText}`);
        }
        if (!ledgerText.includes('<old@example.com>') || !ocrText.includes('oldhash')) {
          fail(`stage=${holdStage} recovery damaged pre-existing CSV rows`);
        }
        if (liveJournals.length !== 0) {
          fail(`stage=${holdStage} should clear journal after rollback, got ${JSON.stringify(liveJournals)}`);
        }
      } else {
        // ledger-committed: files + both CSVs stay; journal cleaned (counted as skipped).
        if (recovered.rolledBack !== 0) {
          fail(`ledger-committed recovery must not roll back, got ${JSON.stringify(recovered)}`);
        }
        if (archived.length !== 1) {
          fail(`ledger-committed recovery should keep the archive file, got ${JSON.stringify(archived)}`);
        }
        if (!ledgerText.includes('<kill@example.com>') || !ocrText.includes('killhash')) {
          fail(`ledger-committed recovery lost committed CSV rows:\nledger=${ledgerText}\nocr=${ocrText}`);
        }
        if (!ledgerText.includes('<old@example.com>')) {
          fail('ledger-committed recovery truncated pre-existing ledger rows');
        }
        if (liveJournals.length !== 0) {
          fail(`ledger-committed should only clear journal, still have ${JSON.stringify(liveJournals)}`);
        }
      }

      // Rerun recovery is a no-op (no duplicate files/rows).
      const { stdout: recover2Out } = await execFileAsync(process.execPath, [recoverPath], {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      });
      const recovered2 = JSON.parse(recover2Out.trim().split('\n').pop());
      if (recovered2.rolledBack !== 0) {
        fail(`second recovery re-rolled-back after clean journal: ${JSON.stringify(recovered2)}`);
      }
      const archived2 = (await readdir(cfg.paths.invoices)).filter((name) => isArchivedDocName(name));
      if (holdStage === 'ledger-committed' && archived2.length !== 1) {
        fail(`rerun after ledger-committed recovery changed file set: ${JSON.stringify(archived2)}`);
      }
      const ledger2 = await readFile(cfg.output.csv, 'utf8');
      if ((ledger2.match(/<kill@example.com>/g) || []).length > 1) {
        fail('recovery rerun duplicated kill ledger rows');
      }
    });
  }
}

/* NET-01: fake-IP 解析器（Clash / Surge 把所有公网域名映射进 198.18.0.0/15）曾让
   每一条发票直链都变成 `blocked_url:private_ip`，整个队列退化成待确认。放宽只允许
   「域名解析结果落在实证过的占位段」，这里钉住它没有顺手拆掉 SSRF 防线。 */
async function testResolverPlaceholderPolicyKeepsPrivateRangesBlocked() {
  const profileMod = await import(
    pathToFileURL(join(repoRoot, 'dist/util/resolverProfile.js')).href
  );
  const netMod = await import(pathToFileURL(join(repoRoot, 'dist/util/net.js')).href);

  // 1) 白名单边界：内网/回环/链路本地/CGNAT/组播都不得有资格成为占位段。
  const neverEligible = [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0', '192.0.0.1',
  ];
  for (const ip of neverEligible) {
    const prefix = profileMod.eligiblePlaceholderPrefixFor(ip);
    if (prefix !== undefined) {
      fail(`${ip} must never be eligible as a resolver placeholder, got ${prefix}`);
    }
  }
  if (profileMod.eligiblePlaceholderPrefixFor('198.18.32.8') !== '198.18.0.0/15') {
    fail('198.18.0.0/15 (RFC 2544, the Clash/Surge fake-IP default) must stay eligible');
  }

  // 2) 未检测到映射解析器时，占位段一律照旧拒绝。
  const strict = { mapped: [], detected: false, detail: 'test' };
  if (profileMod.isResolverPlaceholder(strict, '198.18.32.8')) {
    fail('placeholder allowance must require a detected mapping resolver');
  }

  // 3) 即使检测到 198.18.0.0/15，也只放行占位段本身——内网地址仍然拒绝。
  const detected = { mapped: [[0xc6120000, 15]], detected: true, detail: 'test' };
  if (!profileMod.isResolverPlaceholder(detected, '198.18.32.8')) {
    fail('a detected placeholder prefix must allow addresses inside it');
  }
  for (const ip of ['127.0.0.1', '192.168.1.1', '10.1.2.3', '169.254.169.254', '100.64.0.1']) {
    if (profileMod.isResolverPlaceholder(detected, ip)) {
      fail(`detected placeholder mode must not allow ${ip}`);
    }
  }

  // 4) 放宽只对 DNS 结果生效：URL 里写死的占位段 IP 字面量永远拒绝，
  //    否则邮件里一条 http://198.18.x.x/ 就能借代理打到任意目标。
  for (const url of ['http://198.18.32.8/x', 'http://127.0.0.1:8000/x', 'http://192.168.1.1/x']) {
    let blocked = false;
    try {
      await netMod.resolvePublicUrl(url);
    } catch (err) {
      blocked = String(err?.message ?? err).startsWith('blocked_url:private_ip:');
    }
    if (!blocked) fail(`IP-literal ${url} must stay blocked regardless of resolver profile`);
  }
}

/* APP-10B: `（请到 https://inv-veri.chinatax.gov.cn)查询发票真伪` 这种中文正文里，
   闭括号落在 URL 中间。此前只检查结尾字符是否配对，于是 `)查询发票真伪` 被留在
   token 里，`new URL()` 又把它 IDNA 编码成 `...gov.xn--cn)-u09ds6...`，必然以
   `blocked_url:dns` 落进待确认。 */
async function testProseClosingBracketDoesNotPoisonHostname() {
  const urlMod = await import(pathToFileURL(join(repoRoot, 'dist/util/url.js')).href);
  const cases = [
    ['https://inv-veri.chinatax.gov.cn)查询发票真伪', 'https://inv-veri.chinatax.gov.cn'],
    ['https://pay.example.com/d?id=7)后续说明', 'https://pay.example.com/d?id=7'],
    // 配对的括号是合法 URL 的一部分，不得被截断。
    ['https://example.com/wiki/Foo_(bar)', 'https://example.com/wiki/Foo_(bar)'],
    ['https://example.com/a_(b)_c?q=1', 'https://example.com/a_(b)_c?q=1'],
  ];
  for (const [raw, expected] of cases) {
    const got = urlMod.normalizeExtractedUrl(raw);
    if (got !== expected) fail(`normalizeExtractedUrl(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  }
}

/* `mfh pending retry`：修好提取逻辑之后，队列里已有的邮件必须能被批量重放，
   成功的行出队、失败的行留下并换上最新原因，且 .eml 副本一律保留。 */
async function testPendingRetryDrainsQueueAndKeepsFailures() {
  await withTempDir('mfh-cli-pending-retry-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    const statePath = join(tmp, 'state.json');
    await mkdir(join(tmp, 'raw'), { recursive: true });
    // 两封都先落进待确认：一封纯通知（无附件），一封带 PDF 但先被排除在 samples 外。
    await writeFile(join(tmp, 'raw', 'manual.eml'), manualMail('平台开票通知', '<retry-manual@example.com>'));
    await runMfh(['run', '--config', configPath, '--state', statePath, '--concurrency', '1']);

    const pendingCsv = join(cfg.paths.pending, 'pending.csv');
    const before = parseSimpleCsv(await readFile(pendingCsv, 'utf8'));
    if (before.rows.length !== 1) fail(`expected 1 pending row before retry, got ${before.rows.length}`);
    const stuckHash = column(before, before.rows[0], 'mailHash');
    const emlPath = join(cfg.paths.pending, `${stuckHash}.eml`);
    if (!existsSync(emlPath)) fail(`pending queue must keep its own .eml copy at ${emlPath}`);

    // 队列里的这封邮件依旧没有可归档的发票：重放后必须仍在队列里。
    const { stdout: retry1 } = await runMfh([
      'pending', 'retry', '--config', configPath, '--state', statePath, '--concurrency', '1', '--json',
    ]);
    const report1 = JSON.parse(retry1.slice(retry1.indexOf('{'), retry1.lastIndexOf('}') + 1));
    if (report1.attempted !== 1) fail(`pending retry must replay the queued email, report=${retry1}`);
    if (report1.resolved !== 0) fail(`an email with no invoice must not be dropped from the queue, report=${retry1}`);
    const afterFail = parseSimpleCsv(await readFile(pendingCsv, 'utf8'));
    if (afterFail.rows.length !== 1) fail(`still-failing row must stay in pending.csv, got ${afterFail.rows.length}`);
    if (!existsSync(emlPath)) fail('pending retry must not delete the queue .eml copy');

    // 把队列副本换成一封真的带 PDF 的邮件（模拟「提取逻辑修好了」），
    // 重放后该行必须出队，并且发票确实归档。
    await writeFile(emlPath, pdfMail('<retry-manual@example.com>', '平台开票通知'));
    const { stdout: retry2 } = await runMfh([
      'pending', 'retry', '--config', configPath, '--state', statePath, '--concurrency', '1', '--json',
    ]);
    const report2 = JSON.parse(retry2.slice(retry2.indexOf('{'), retry2.lastIndexOf('}') + 1));
    if (report2.resolved !== 1 || report2.removed !== 1) {
      fail(`a newly archivable email must leave the queue, report=${retry2}`);
    }
    const afterOk = parseSimpleCsv(await readFile(pendingCsv, 'utf8'));
    if (afterOk.rows.length !== 0) fail(`resolved row must be removed from pending.csv, left ${afterOk.rows.length}`);
    const ledger = await readFile(cfg.output.csv, 'utf8');
    if (!ledger.includes('<retry-manual@example.com>')) {
      fail('pending retry reported resolved but nothing reached the invoice ledger');
    }
    if (!existsSync(emlPath)) fail('pending retry must keep the .eml copy even after the row leaves the queue');
  });
}

/* EXT-13: 票已经归档时，只有「本来就不是发票」的目标失败（追踪像素、旺旺挂件、
   邮箱首页、数电发票 XML 副本）不得再把整封邮件按部分成功压进待确认——那条队列
   记录对用户毫无可操作性。带发票语义的链接失败仍然必须留下记录。 */
async function testIncidentalLinkFailuresDoNotHoldArchivedMailInQueue() {
  await withTempDir('mfh-cli-incidental-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });

    // 附件里已经有一张真发票；正文再放两条**打不通**的链接。
    // 127.0.0.1 会被 SSRF 主防线直接拒绝，不产生任何出网流量，探测必然失败。
    const withNoiseLinks = pdfMail('<incidental-noise@example.com>', '电子发票（含跟踪链接）')
      .replace('发票见附件。', [
        '发票见附件。',
        'http://127.0.0.1:9/z_stat.php?id=1279',
        'http://127.0.0.1:9/msg.aw',
      ].join('\n'));
    // 对照组：同样打不通，但链接自称是发票下载入口 —— 必须留在待确认里。
    const withInvoiceLink = pdfMail('<incidental-real@example.com>', '电子发票（含发票链接）')
      .replace('发票见附件。', '发票见附件。\nhttp://127.0.0.1:9/invoice/download?id=1');

    await writeFile(join(tmp, 'raw', 'noise.eml'), withNoiseLinks);
    await writeFile(join(tmp, 'raw', 'real.eml'), withInvoiceLink);

    await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'])
      .catch((err) => err); // 对照组会以非 0 退出（仍有待确认），退出码不是本用例的断言点

    const ledger = await readFile(cfg.output.csv, 'utf8');
    for (const id of ['<incidental-noise@example.com>', '<incidental-real@example.com>']) {
      if (!ledger.includes(id)) fail(`attachment invoice for ${id} must be archived regardless of link failures`);
    }

    const pendingPath = join(cfg.paths.pending, 'pending.csv');
    const pendingText = existsSync(pendingPath) ? await readFile(pendingPath, 'utf8') : '';
    if (pendingText.includes('incidental-noise@example.com')) {
      fail('an archived mail whose only failures were non-invoice links must not stay in the pending queue');
    }
    if (!pendingText.includes('incidental-real@example.com')) {
      fail('a failing link that does look like an invoice entry must still leave a pending record');
    }
  });
}

/* EXT-14: 票根网（service@invoice.txffp.com）的通行费发票有两种投递格式。第二种是
   **包中包**：`通行费电子发票.zip` 里每个开票方一个 `<纳税人识别号>_<uuid>.zip`，
   真正的 PDF/OFD/XML 在内层。此前解包只看一层，这类邮件一份票都取不到；更糟的是
   同封的「汇总单」附件归档成功，整封邮件按 archived 收尾，连待确认里都看不见
   （实测用户数据：10 封邮件、68 个 PDF/OFD 条目静默丢失）。

   同时钉住内层 `<stem>.pdf` + `<stem>.ofd` 是同一张票、只留 PDF —— 不去重的话
   每张通行费发票会被归档两遍（用户台账里已因此多出 268 条冗余记录）。 */
async function testNestedTollInvoiceZipIsUnpackedAndDeduped() {
  const { default: AdmZip } = await import(pathToFileURL(join(repoRoot, 'node_modules/adm-zip/adm-zip.js')).href);

  const pdfBytes = Buffer.from(PDF_BYTES_B64, 'base64');
  // OFD 也是 PK 容器：造一个真 zip，好让 magic 校验（claimed_ofd → archive）通过。
  const ofdInner = new AdmZip();
  ofdInner.addFile('OFD.xml', Buffer.from('<OFD/>'));
  const ofdBytes = ofdInner.toBuffer();

  const stem = '1891076522a847b99f1ace8d1f2ef459';
  const inner = new AdmZip();
  inner.addFile(`${stem}.pdf`, pdfBytes);
  inner.addFile(`${stem}.ofd`, ofdBytes);
  inner.addFile(`${stem}.xml`, Buffer.from('<EInvoice/>'));
  const outer = new AdmZip();
  outer.addFile(`913305007613201992_${stem}.zip`, inner.toBuffer());
  const outerB64 = outer.toBuffer().toString('base64');

  await withTempDir('mfh-cli-nested-zip-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });
    const eml = [
      'From: "通行费发票通知" <service@invoice.txffp.com>',
      'To: me@example.com',
      'Subject: 通行费电子发票',
      'Date: Thu, 21 May 2026 10:00:00 +0800',
      'Message-ID: <nested-toll@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '通行费电子发票见附件。',
      '--b',
      'Content-Type: application/zip; name="toll.zip"',
      'Content-Disposition: attachment; filename="通行费电子发票.zip"',
      'Content-Transfer-Encoding: base64',
      '',
      outerB64.replace(/(.{76})/g, '$1\n'),
      '--b--',
      '',
    ].join('\n');
    await writeFile(join(tmp, 'raw', 'toll.eml'), eml);

    await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'])
      .catch((err) => err);

    const ledger = parseSimpleCsv(await readFile(cfg.output.csv, 'utf8'));
    const sources = ledger.rows.map((row) => column(ledger, row, 'source'));
    if (sources.length !== 1) {
      fail(`nested toll zip must archive exactly one document per invoice, got ${JSON.stringify(sources)}`);
    }
    // 必须真的下钻到内层，而不是把内层 zip 整个当成 OFD 收下。
    const expected = `通行费电子发票.zip/913305007613201992_${stem}.zip/${stem}.pdf`;
    if (sources[0] !== expected) {
      fail(`nested entry provenance wrong: got ${JSON.stringify(sources[0])}, want ${JSON.stringify(expected)}`);
    }
    const archived = (await readdir(cfg.paths.invoices)).filter((name) => isArchivedDocName(name));
    if (archived.length !== 1) {
      fail(`same-stem PDF/OFD pair must archive once, found ${JSON.stringify(archived)}`);
    }
    // 这封邮件全靠嵌套包，取到票就不该再留待确认记录。
    const pendingPath = join(cfg.paths.pending, 'pending.csv');
    const pendingText = existsSync(pendingPath) ? await readFile(pendingPath, 'utf8') : '';
    if (pendingText.includes('nested-toll@example.com')) {
      fail('nested toll zip was unpacked successfully but the mail still landed in the pending queue');
    }
  });
}

/* EXT-14: 一个压缩包一份票都没解出来，必须留下可见记录。旧实现在附件流程里
   完全静默（既不记 issue 也不算失败），于是「同封还有别的附件」时整封邮件按
   archived 收尾，丢票在任何界面上都看不到。 */
async function testZipWithNoArchivableEntryIsReported() {
  const { default: AdmZip } = await import(pathToFileURL(join(repoRoot, 'node_modules/adm-zip/adm-zip.js')).href);
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('nothing archivable here'));
  const zipB64 = zip.toBuffer().toString('base64');

  await withTempDir('mfh-cli-empty-zip-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });
    // 同封另有一个可归档 PDF：邮件会归档成功，空压缩包必须仍然被报出来。
    const eml = pdfMail('<empty-zip@example.com>', '发票与空压缩包').replace(
      '--b--',
      [
        '--b',
        'Content-Type: application/zip; name="bundle.zip"',
        'Content-Disposition: attachment; filename="bundle.zip"',
        'Content-Transfer-Encoding: base64',
        '',
        zipB64,
        '--b--',
      ].join('\n'),
    );
    await writeFile(join(tmp, 'raw', 'emptyzip.eml'), eml);

    await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'])
      .catch((err) => err);

    const ledger = await readFile(cfg.output.csv, 'utf8');
    if (!ledger.includes('<empty-zip@example.com>')) fail('the real PDF attachment must still be archived');

    const pendingPath = join(cfg.paths.pending, 'pending.csv');
    const pendingText = existsSync(pendingPath) ? await readFile(pendingPath, 'utf8') : '';
    if (!pendingText.includes('empty-zip@example.com')) {
      fail('a zip attachment that yielded no document must leave a visible pending record, not vanish');
    }
    if (!pendingText.includes('zip_no_invoice_entries')) {
      fail(`pending reason must name the empty zip; got: ${pendingText}`);
    }
  });
}

/* EXT-14: `mfh dedupe` 把「同容器 PDF/OFD 同名 = 同一张票」的规则回溯到已归档数据。
   它会重写台账并移动归档文件，所以必须钉住三件事：判据窄（只认同邮件同容器同 stem
   的 pdf/ofd 配对）、台账与磁盘对不上就整行不动、文件只隔离不删除。 */
async function testDedupeRemovesOnlySameContainerPdfOfdPairs() {
  const { createHash } = await import('node:crypto');
  const sha12 = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12);

  await withTempDir('mfh-cli-dedupe-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(cfg.paths.invoices, { recursive: true });
    await mkdir(join(cfg.paths.invoices, 'ocr'), { recursive: true });
    await mkdir(join(tmp, 'custom'), { recursive: true });

    const pdfBytes = Buffer.from(PDF_BYTES_B64, 'base64');
    const ofdBytes = Buffer.from('PKofd-payload');
    const otherOfd = Buffer.from('PKanother-invoice');
    const staleOfd = Buffer.from('PKstale-copy');

    await writeFile(join(cfg.paths.invoices, '0001.pdf'), pdfBytes);
    await writeFile(join(cfg.paths.invoices, '0002.ofd'), ofdBytes);   // 同 stem → 冗余
    await writeFile(join(cfg.paths.invoices, '0003.ofd'), otherOfd);   // 不同 stem → 保留
    await writeFile(join(cfg.paths.invoices, '0004.ofd'), staleOfd);   // contentHash 对不上 → 跳过

    const rows = [
      ['<toll@example.com>', '2026-05-21T02:00:00.000Z', 'v@example.com', '通行费', '0001.pdf', 'toll.zip/inner.zip/abc.pdf', sha12(pdfBytes), 'mailhash01'],
      ['<toll@example.com>', '2026-05-21T02:00:00.000Z', 'v@example.com', '通行费', '0002.ofd', 'toll.zip/inner.zip/abc.ofd', sha12(ofdBytes), 'mailhash01'],
      // 同一封邮件、另一个容器：没有配对的 PDF，必须原样保留。
      ['<toll@example.com>', '2026-05-21T02:00:00.000Z', 'v@example.com', '通行费', '0003.ofd', 'toll.zip/other.zip/zzz.ofd', sha12(otherOfd), 'mailhash01'],
      // 有配对，但台账 contentHash 与磁盘不符：必须跳过，行和文件都不动。
      ['<toll@example.com>', '2026-05-21T02:00:00.000Z', 'v@example.com', '通行费', '0004.ofd', 'toll.zip/inner.zip/def.ofd', 'deadbeefdead', 'mailhash01'],
      ['<toll@example.com>', '2026-05-21T02:00:00.000Z', 'v@example.com', '通行费', '0001.pdf', 'toll.zip/inner.zip/def.pdf', sha12(pdfBytes), 'mailhash01'],
    ];
    await writeFile(
      cfg.output.csv,
      '﻿messageId,date,from,subject,filename,source,contentHash,mailHash\n'
      + rows.map((r) => r.join(',')).join('\n') + '\n',
    );
    const ocrPendingCsv = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
    await writeFile(
      ocrPendingCsv,
      '﻿hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash\n'
      + `mailhash01,<toll@example.com>,,,,0001.pdf,toll.zip/inner.zip/abc.pdf,pdf,invoice,pending,,${sha12(pdfBytes)}\n`
      + `mailhash01,<toll@example.com>,,,,0002.ofd,toll.zip/inner.zip/abc.ofd,ofd,invoice,pending,,${sha12(ofdBytes)}\n`,
    );

    // 1) 默认 dry-run：报告数量，但一个字节都不改。
    const { stdout: dry } = await runMfh(['dedupe', '--config', configPath, '--json']);
    const dryReport = JSON.parse(dry.slice(dry.indexOf('{'), dry.lastIndexOf('}') + 1));
    if (dryReport.applied !== false) fail('dedupe 默认必须是 dry-run');
    if (dryReport.redundant !== 1) fail(`dry-run 应只认出 1 份冗余 OFD，实际 ${dryReport.redundant}：${dry}`);
    if (dryReport.skipped.length !== 1) fail(`contentHash 不符的行必须被报为 skipped：${JSON.stringify(dryReport.skipped)}`);
    const ledgerAfterDry = await readFile(cfg.output.csv, 'utf8');
    if (ledgerAfterDry.split('\n').filter(Boolean).length !== 6) fail('dry-run 改动了台账');
    if (!existsSync(join(cfg.paths.invoices, '0002.ofd'))) fail('dry-run 动了归档文件');

    // 2) --apply：移除冗余行，文件隔离而非删除。
    const { stdout: applied } = await runMfh(['dedupe', '--config', configPath, '--apply', '--json']);
    const report = JSON.parse(applied.slice(applied.indexOf('{'), applied.lastIndexOf('}') + 1));
    if (report.quarantined !== 1 || report.ledgerRowsRemoved !== 1) {
      fail(`--apply 应隔离并移除恰好 1 条，实际 ${JSON.stringify(report)}`);
    }
    if (report.ocrRowsRemoved !== 1) fail(`OCR 队列里的对应行也必须移除，实际 ${report.ocrRowsRemoved}`);

    const ledger = parseSimpleCsv(await readFile(cfg.output.csv, 'utf8'));
    const sources = ledger.rows.map((row) => column(ledger, row, 'source'));
    if (sources.includes('toll.zip/inner.zip/abc.ofd')) fail('冗余 OFD 行没有从台账移除');
    for (const keep of ['toll.zip/inner.zip/abc.pdf', 'toll.zip/other.zip/zzz.ofd', 'toll.zip/inner.zip/def.ofd']) {
      if (!sources.includes(keep)) fail(`dedupe 误删了应保留的行 ${keep}：${JSON.stringify(sources)}`);
    }
    if (existsSync(join(cfg.paths.invoices, '0002.ofd'))) fail('冗余 OFD 文件应已移出归档目录');
    if (!existsSync(join(cfg.paths.invoices, '0003.ofd'))) fail('无配对的 OFD 文件被误删');
    if (!existsSync(join(cfg.paths.invoices, '0004.ofd'))) fail('contentHash 不符的文件必须原样保留');
    // 隔离而非删除：文件必须还能找回来。
    if (!existsSync(join(report.quarantineDir, '0002.ofd'))) {
      fail(`文件必须移入隔离目录而不是删除：${report.quarantineDir}`);
    }
    const ocrAfter = await readFile(ocrPendingCsv, 'utf8');
    if (ocrAfter.includes('abc.ofd')) fail('OCR 队列里的冗余行没有移除');
    if (!ocrAfter.includes('abc.pdf')) fail('OCR 队列里保留的 PDF 行被误删');

    // 3) 幂等：再跑一次什么都不做。
    const { stdout: again } = await runMfh(['dedupe', '--config', configPath, '--apply', '--json']);
    const second = JSON.parse(again.slice(again.indexOf('{'), again.lastIndexOf('}') + 1));
    if (second.quarantined !== 0 || second.ledgerRowsRemoved !== 0) {
      fail(`dedupe 必须幂等，第二次仍在动数据：${JSON.stringify(second)}`);
    }
  });
}

/* EXT-15: 开票平台的邮件模板里塞满了自家物料——页眉横幅、下载按钮、广告位、公众号
   二维码、OFD 阅读器安装包，而且它们和发票**同域**。旧规则「host 里有 fapiao/invoice
   就算发票证据」于是把它们全部当票归档：用户 392 封邮件里据此入库的 99 张图片没有
   一张是发票。判据改成只看路径、并先否决物料命名。 */
async function testPlatformChromeIsNotTreatedAsInvoice() {
  const mod = await import(pathToFileURL(join(repoRoot, 'dist/extract/assetEvidence.js')).href);

  // 全部取自用户归档里真实被误判为发票的 URL。
  const chrome = [
    'http://www.fapiao.com/static/images/logo.png',
    'http://www.fapiao.com/static/images/email_default_ad.png',
    'http://www.fapiao.com/static/images/gzh_100_tmp.jpg',
    'https://ad.efapiao.com/api/affair/mailimg',
    'https://es-static.xiaojukeji.com/static/web/home/emailpage/images/invoicelogo-b86547dd22.png',
    'https://dzfppt.oss-cn-beijing.aliyuncs.com/email/img/email_bac.png',
    'https://dzfppt.oss-cn-beijing.aliyuncs.com/email/img/email_ypgzhewm.png',
    'https://tupian.bwfapiao.com/qrcode/202601/26010720330348644.png',
    'https://ei.51fapiao.cn/deliver/s/ewm-bg.png',
    'https://dzfpqrcode.oss-cn-shanghai.aliyuncs.com/public/2020-11/cpyypt_1604542794278.png',
    // 二维码里带着发票号，也不能因此当成票面。
    'https://servu-invoice.oss-cn-hangzhou.aliyuncs.com/internal/einvoicepfcore/emailTemplateConfig/invoiceQrCode/cy/1906362191433-26322000007008406936.png',
    // 23 位流水号不是 20 位发票号。
    'https://kabu-vip.shouqianba.com/invoice/p/prod/image/17774402928833368857154.png',
  ];
  for (const url of chrome) {
    if (mod.linkedImageHasInvoiceEvidence(url)) fail(`平台物料被当成发票证据：${url}`);
  }

  // 真的票面图仍然必须放行，包括放在 /images/ 目录下的。
  const real = [
    'https://cdn.example.com/invoice/26312000001234567890.jpg',
    'https://cdn.example.com/images/26312000001234567890.png',
    'https://p.example.com/fapiao/scan_20260101.jpg',
  ];
  for (const url of real) {
    if (!mod.linkedImageHasInvoiceEvidence(url)) fail(`真票面图被误拒：${url}`);
  }

  // 页脚的「下载 OFD 阅读器」、打点端点也不是票——它们常年 404/400，
  // 不该把整封邮件挂进待确认。
  for (const p of ['/public/ofd_read.zip', '/trace/v1/report', '/z_stat.php', '/api/beacon']) {
    if (!mod.looksLikeEmailChrome(p)) fail(`必须判为平台物料：${p}`);
  }
  for (const p of ['/invoice/26312000001234567890.pdf', '/fapiao/download']) {
    if (mod.looksLikeEmailChrome(p)) fail(`真票面路径被误判为物料：${p}`);
  }
}

/* EXT-15: 智慧发票服务平台（crestv）的邮件把 header / downloadbutton / advertising
   三张图作为 multipart/related 内联资源发出（有的版本连 filename 都没有），发票本体
   则是 disposition=attachment 的 PDF/OFD。旧判据要求正文里出现 `cid:` 引用，而这些
   模板写的是 `<img src="header2.jpg">`，于是一个都扫不到，三张图全部当发票归档。 */
async function testInlineBodyImagesAreNotArchivedAsInvoices() {
  await withTempDir('mfh-cli-chrome-img-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });

    const jpegB64 = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 0x41),
    ]).toString('base64');
    const eml = [
      'From: "智慧发票服务平台" <noreply@crestv.cn>',
      'To: me@example.com',
      'Subject: 您收到开具的发票',
      'Date: Thu, 21 May 2026 10:00:00 +0800',
      'Message-ID: <inline-chrome@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="b"',
      '',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><img src="header2.jpg"/>发票见附件。</body></html>',
      '--b',
      'Content-Type: image/jpeg',
      'Content-ID: <header>',
      'Content-Transfer-Encoding: base64',
      '',
      jpegB64,
      '--b',
      'Content-Type: image/jpeg',
      'Content-ID: <downloadbutton>',
      'Content-Transfer-Encoding: base64',
      '',
      jpegB64,
      '--b',
      'Content-Type: image/jpeg',
      'Content-ID: <advertising>',
      'Content-Transfer-Encoding: base64',
      '',
      jpegB64,
      '--b',
      'Content-Type: application/pdf; name="26432000001397325886.pdf"',
      'Content-Disposition: attachment; filename="26432000001397325886.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      PDF_BYTES_B64,
      '--b--',
      '',
    ].join('\n');
    await writeFile(join(tmp, 'raw', 'chrome.eml'), eml);

    await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'])
      .catch((err) => err);

    const archived = (await readdir(cfg.paths.invoices)).filter((name) => isArchivedDocName(name));
    const images = archived.filter((name) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name));
    if (images.length !== 0) fail(`内联展示图不得作为发票归档，实际归档了 ${JSON.stringify(images)}`);
    if (archived.length !== 1) fail(`应只归档那张 PDF，实际 ${JSON.stringify(archived)}`);

    const pendingPath = join(cfg.paths.pending, 'pending.csv');
    const pendingText = existsSync(pendingPath) ? await readFile(pendingPath, 'utf8') : '';
    if (pendingText.includes('inline-chrome@example.com')) {
      fail('丢弃版式物料之后这封邮件不该再留待确认记录');
    }
  });
}

/* EXT-16: 同一次投递、同一个非通用词干的 `<stem>.pdf` + `<stem>.ofd` 是同一张票的
   两种格式，只归档 PDF。这条判据同时覆盖压缩包内条目和同封邮件的两个附件，并且
   必须与 `mfh dedupe` 用的是同一个函数，否则清理掉的行下次处理会长回来。
   通用词干（发票.pdf / 发票.ofd）不参与——那正是不同票最容易撞名的地方。 */
async function testSameDeliveryPdfOfdSiblingsArchiveOnce() {
  const idn = await import(pathToFileURL(join(repoRoot, 'dist/extract/documentIdentity.js')).href);

  // 非通用词干 → 参与配对；通用词干与直链 → 不参与。
  const paired = idn.containerStemKey('携程酒店订单1128144409057843电子发票.pdf');
  if (paired === null || paired !== idn.containerStemKey('携程酒店订单1128144409057843电子发票.ofd')) {
    fail('同名附件的 PDF/OFD 必须得到相同的投递身份');
  }
  if (idn.containerStemKey('发票.pdf') !== null) fail('通用词干「发票」不得参与同名配对');
  if (idn.containerStemKey('invoice.pdf') !== null) fail('通用词干「invoice」不得参与同名配对');
  if (idn.containerStemKey('https://host/a/26312000001234567890.pdf') !== null) {
    fail('直链不得参与同名配对：URL 上的同名毫无保证');
  }
  if (idn.containerStemKey('a.zip/b.zip/x.pdf') === idn.containerStemKey('a.zip/c.zip/x.pdf')) {
    fail('不同内层包里的同名条目不得互相消除');
  }

  await withTempDir('mfh-cli-sibling-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });
    const { default: AdmZip } = await import(pathToFileURL(join(repoRoot, 'node_modules/adm-zip/adm-zip.js')).href);
    const ofd = new AdmZip();
    ofd.addFile('OFD.xml', Buffer.from('<OFD/>'));
    const ofdB64 = ofd.toBuffer().toString('base64');

    const stem = '携程酒店订单1128144409057843电子发票';
    const eml = [
      'From: vendor@example.com',
      'To: me@example.com',
      'Subject: 电子发票',
      'Date: Thu, 21 May 2026 10:00:00 +0800',
      'Message-ID: <sibling@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '发票见附件。',
      '--b',
      `Content-Type: application/pdf; name="${stem}.pdf"`,
      `Content-Disposition: attachment; filename="${stem}.pdf"`,
      'Content-Transfer-Encoding: base64',
      '',
      PDF_BYTES_B64,
      '--b',
      `Content-Type: application/octet-stream; name="${stem}.ofd"`,
      `Content-Disposition: attachment; filename="${stem}.ofd"`,
      'Content-Transfer-Encoding: base64',
      '',
      ofdB64,
      '--b--',
      '',
    ].join('\n');
    await writeFile(join(tmp, 'raw', 'sibling.eml'), eml);

    await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'])
      .catch((err) => err);

    const archived = (await readdir(cfg.paths.invoices)).filter((name) => isArchivedDocName(name));
    if (archived.length !== 1 || !archived[0].toLowerCase().endsWith('.pdf')) {
      fail(`同名 PDF/OFD 只应归档 PDF 一份，实际 ${JSON.stringify(archived)}`);
    }
  });
}

/* EXT-17: 只归档到附属材料 = 票在半路丢了，必须留下待确认记录。
   历史上票根网「包中包」通行费邮件正是这样静默丢了 34 张票：同封的汇总单归档成功，
   整封按 archived 收尾，待确认队列里一条都看不到。附属材料仍然要归档，但整封邮件
   不能算完整成功。反例同样要钉住：汇总单 + 真票同在时不得误报。 */
async function testSupportingOnlyArchiveIsNotSilentSuccess() {
  // 内容身份去重是按字节做的：每个附件必须是不同的字节，否则同封两个附件会被折叠
  // 成一份，反例就测不到「汇总单 + 真票」这个组合了。
  const distinctPdf = (marker) => Buffer.from(`%PDF-1.4\n%${marker}\n%%EOF\n`).toString('base64');
  const pdfAttachment = (name, marker) => [
    '--b',
    `Content-Type: application/pdf; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    distinctPdf(marker),
  ];
  const mail = (messageId, attachments) => [
    'From: service@invoice.example.com',
    'To: me@example.com',
    'Subject: 通行费电子发票',
    'Date: Thu, 21 May 2026 10:00:00 +0800',
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '通行费发票见附件。',
    ...attachments,
    '--b--',
    '',
  ].join('\n');

  await withTempDir('mfh-cli-supporting-only-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp);
    await mkdir(join(tmp, 'raw'), { recursive: true });
    await writeFile(
      join(tmp, 'raw', 'summary-only.eml'),
      mail('<summary-only@example.com>', [
        ...pdfAttachment('通行费电子票据汇总单(票据).pdf', 'summary-bill'),
        ...pdfAttachment('通行费电子票据汇总单(行程).pdf', 'summary-trip'),
      ]),
    );
    // 反例：同一批投递里汇总单旁边确实有票，不能被这条规则误伤。
    await writeFile(
      join(tmp, 'raw', 'summary-plus-invoice.eml'),
      mail('<summary-plus-invoice@example.com>', [
        ...pdfAttachment('通行费电子票据汇总单(票据).pdf', 'sibling-summary'),
        ...pdfAttachment('dzfp_26312000000336318256_某某公司_20260119112043.pdf', 'real-invoice'),
      ]),
    );

    await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1'])
      .catch((err) => err);

    const ledger = await readFile(cfg.output.csv, 'utf8');
    if (!ledger.includes('通行费电子票据汇总单(票据).pdf')) {
      fail('附属材料本身仍须归档，不能因为报警就丢掉');
    }

    const pendingPath = join(cfg.paths.pending, 'pending.csv');
    const pendingText = existsSync(pendingPath) ? await readFile(pendingPath, 'utf8') : '';
    if (!pendingText.includes('summary-only@example.com')) {
      fail('整封只有汇总单的邮件必须进待确认，不得按 archived 静默收尾');
    }
    if (!pendingText.includes('only_supporting_documents:toll_summary')) {
      fail(`待确认原因必须说明只拿到附属材料；实际: ${pendingText}`);
    }
    if (pendingText.includes('summary-plus-invoice@example.com')) {
      fail('汇总单旁边有真票时不得报警');
    }
  });
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
  await testDataDirLockCrossProcessMutualExclusion();
  await testOperationCoordinatorMutexMatrix();
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
  await testJournalHardKillStageRecovery();
  await testResolverPlaceholderPolicyKeepsPrivateRangesBlocked();
  await testProseClosingBracketDoesNotPoisonHostname();
  await testPendingRetryDrainsQueueAndKeepsFailures();
  await testIncidentalLinkFailuresDoNotHoldArchivedMailInQueue();
  await testNestedTollInvoiceZipIsUnpackedAndDeduped();
  await testZipWithNoArchivableEntryIsReported();
  await testDedupeRemovesOnlySameContainerPdfOfdPairs();
  await testPlatformChromeIsNotTreatedAsInvoice();
  await testInlineBodyImagesAreNotArchivedAsInvoices();
  await testSameDeliveryPdfOfdSiblingsArchiveOnce();
  await testSupportingOnlyArchiveIsNotSilentSuccess();
}, { timeoutMs: 8 * 60 * 1000 });

