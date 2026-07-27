/* End-to-end integration against the *real compiled CLI* (CODE-02).
 *
 * The Electron suite (electron-ipc-fixture.mjs) deliberately stubs the CLI out
 * with MFH_E2E_FAKE_CLI=1, so nothing there proves the pipeline works. This
 * file closes that gap: an isolated data directory, hand-built `.eml` fixtures,
 * and real `node dist/index.js run|ocr run|organize` invocations. It asserts the
 * artifacts users actually depend on — archived files, the invoice ledger, the
 * OCR queue, the results CSV, state.json and the organized output.
 *
 * IMAP fetching is the only stage not covered: it needs a live mail server.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertFreshBuild, fail, repoRoot, runSuite, useTempDir, withCleanup } from './_shared.mjs';

const execFileAsync = promisify(execFile);

/* A tiny but structurally valid PDF; the pipeline sniffs magic bytes. */
const INVOICE_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n', 'utf8');
const ITINERARY_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Trip 1 >>\nendobj\ntrailer\n%%EOF\n', 'utf8');

function attachmentMail({ messageId, subject, filename, bytes, date = 'Thu, 21 May 2026 10:00:00 +0800' }) {
  return [
    'From: 供应商 <vendor@example.com>',
    'To: me@example.com',
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mfh"',
    '',
    '--mfh',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '发票见附件。',
    '--mfh',
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    bytes.toString('base64'),
    '--mfh--',
    '',
  ].join('\n');
}

function noAttachmentMail({ messageId, subject }) {
  return [
    'From: 平台 <notice@example.com>',
    'To: me@example.com',
    `Subject: ${subject}`,
    'Date: Thu, 21 May 2026 11:00:00 +0800',
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '请登录平台自行下载发票。',
    '',
  ].join('\n');
}

function buildConfig(dataDir) {
  return {
    // schema v3: `llm`, `output.dir`, `output.pendingDir` and
    // `playwright.browserManagement` were removed as never-read fields.
    schemaVersion: 3,
    imap: { host: 'imap.example.com', port: 993, user: 'me@example.com', pass: '***', tls: true, mailbox: [] },
    filter: { keywords: ['发票', '行程单'], matchSubject: true, matchBody: true, sinceDays: 30, since: null, until: null },
    paths: {
      samples: join(dataDir, 'samples', 'raw'),
      invoices: join(dataDir, 'invoices'),
      pending: join(dataDir, 'pending'),
    },
    output: {
      csv: join(dataDir, 'invoices.csv'),
    },
    rename: {
      rule: '{seller}-{amount}.pdf',
      fallback: '{date}-{messageId}.pdf',
      avoidConflictBeforeOcr: true,
      applyAfterOcr: false,
      organizeByType: false,
      typeDirRule: '{documentType}',
      organizedDir: join(dataDir, 'organized'),
    },
    ocr: {
      enabled: true,
      // The bundled `mock` provider keeps the assertion deterministic while the
      // rest of the OCR runner (queue, checkpointing, results CSV, identity
      // verification) is the real production code path.
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
      resultsCsv: join(dataDir, 'invoices', 'ocr', 'ocr-results.csv'),
      credentials: { tencentRegion: 'ap-shanghai' },
    },
    playwright: { headless: true, timeoutMs: 30000 },
    network: { retries: 0, retryDelayMs: 0 },
  };
}

async function mfh(args, env = {}) {
  const { stdout, stderr } = await execFileAsync('node', ['dist/index.js', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return `${stdout}\n${stderr}`;
}

function parseCsvFile(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/).filter(Boolean);
  const header = (lines[0] || '').split(',');
  return {
    header,
    rows: lines.slice(1).map((line) => {
      const cells = line.split(',');
      const row = {};
      header.forEach((name, index) => { row[name] = cells[index] ?? ''; });
      return row;
    }),
  };
}

async function readCsv(path) {
  if (!existsSync(path)) fail(`预期的 CSV 不存在：${path}`);
  return parseCsvFile(await readFile(path, 'utf8'));
}

async function main() {
  await assertFreshBuild();

  await withCleanup(async (scope) => {
    const dataDir = await useTempDir(scope, 'mfh-cli-integration-');
    const cfg = buildConfig(dataDir);
    const configPath = join(dataDir, 'config.json');
    const statePath = join(dataDir, 'state.json');
    await mkdir(cfg.paths.samples, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);

    // Three mails: one invoice attachment, one itinerary attachment, one that
    // carries nothing downloadable and must land in the pending queue.
    await writeFile(join(cfg.paths.samples, 'invoice.eml'), attachmentMail({
      messageId: '<integration-invoice@example.com>',
      subject: '电子发票通知',
      filename: 'invoice.pdf',
      bytes: INVOICE_PDF,
    }));
    await writeFile(join(cfg.paths.samples, 'itinerary.eml'), attachmentMail({
      messageId: '<integration-itinerary@example.com>',
      subject: '行程单通知',
      filename: 'trip.pdf',
      bytes: ITINERARY_PDF,
      date: 'Wed, 20 May 2026 09:00:00 +0800',
    }));
    await writeFile(join(cfg.paths.samples, 'manual.eml'), noAttachmentMail({
      messageId: '<integration-manual@example.com>',
      subject: '发票已开具，请登录下载',
    }));

    /* ---------- Stage 1: `mfh run` — download, archive, ledger, state ------- */
    const runOut = await mfh(['run', '--config', configPath, '--state', statePath, '--concurrency', '2']);
    if (!/Run complete: processed=3, partial=0, skipped=0, failed=0/.test(runOut)) {
      fail(`真实 CLI run 的汇总不符合预期：\n${runOut}`);
    }
    if (!/No extractor matched \w+, -> manual/.test(runOut)) {
      fail(`没有可下载内容的邮件应被路由到 manual：\n${runOut}`);
    }

    const archived = (await readdir(cfg.paths.invoices)).filter((name) => name.toLowerCase().endsWith('.pdf')).sort();
    if (archived.length !== 2) fail(`应归档 2 个文件，实际 ${JSON.stringify(archived)}`);
    // avoidConflictBeforeOcr is on, so archiving uses collision-free numbering.
    if (!archived.every((name) => /^\d{4}\.pdf$/.test(name))) {
      fail(`avoidConflictBeforeOcr 应先按数字顺序命名，实际 ${JSON.stringify(archived)}`);
    }

    const ledger = await readCsv(cfg.output.csv);
    if (ledger.rows.length !== 2) fail(`invoices.csv 应有 2 行，实际 ${ledger.rows.length}`);
    for (const name of ['messageId', 'date', 'from', 'subject', 'filename', 'source', 'contentHash']) {
      if (!ledger.header.includes(name)) fail(`invoices.csv 缺少列 ${name}：${ledger.header.join(',')}`);
    }
    const invoiceLedgerRow = ledger.rows.find((row) => row.messageId === '<integration-invoice@example.com>');
    const itineraryLedgerRow = ledger.rows.find((row) => row.messageId === '<integration-itinerary@example.com>');
    if (!invoiceLedgerRow || !itineraryLedgerRow) {
      fail(`invoices.csv 没有覆盖两封带附件的邮件：${JSON.stringify(ledger.rows)}`);
    }
    if (invoiceLedgerRow.source !== 'invoice.pdf' || itineraryLedgerRow.source !== 'trip.pdf') {
      fail(`invoices.csv 丢失了原始附件名：${JSON.stringify(ledger.rows)}`);
    }
    if (!invoiceLedgerRow.contentHash || invoiceLedgerRow.contentHash === itineraryLedgerRow.contentHash) {
      fail(`两个不同附件应有不同的 contentHash：${JSON.stringify(ledger.rows)}`);
    }

    // The archived bytes must be the attachment bytes, and each ledger row must
    // point at the file that really holds them (APP-06A identity contract).
    const bytesByLedgerRow = new Map();
    for (const row of ledger.rows) {
      bytesByLedgerRow.set(row.messageId, await readFile(join(cfg.paths.invoices, row.filename)));
    }
    if (!bytesByLedgerRow.get('<integration-invoice@example.com>').equals(INVOICE_PDF)) {
      fail('归档后的发票文件内容与邮件附件不一致');
    }
    if (!bytesByLedgerRow.get('<integration-itinerary@example.com>').equals(ITINERARY_PDF)) {
      fail('归档后的行程单文件内容与邮件附件不一致');
    }

    // The third mail produced no artifact, so it must be recoverable from the
    // pending queue rather than silently dropped.
    const pendingCsv = await readCsv(join(cfg.paths.pending, 'pending.csv'));
    const pendingRow = pendingCsv.rows.find((row) => row.messageId === '<integration-manual@example.com>');
    if (!pendingRow) fail(`没有下载到文件的邮件必须进入待确认队列：${JSON.stringify(pendingCsv.rows)}`);
    if (!pendingRow.reason) fail(`待确认行必须记录原因：${JSON.stringify(pendingRow)}`);
    const quarantined = (await readdir(cfg.paths.pending)).filter((name) => name.endsWith('.eml'));
    if (quarantined.length !== 1) fail(`待确认目录应保留 1 封原始邮件，实际 ${JSON.stringify(quarantined)}`);

    // state.json must record the two processed mails so a rerun is a no-op.
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (!Array.isArray(state.processedHashes) || state.processedHashes.length !== 3) {
      fail(`state.json 应记录 3 封已处理邮件（含进入待确认的那封），实际 ${JSON.stringify(state)}`);
    }
    if (!Array.isArray(state.fetchedHashes)) fail(`state.json 缺少 fetchedHashes：${JSON.stringify(state)}`);

    /* ---------- Stage 2: rerun must be idempotent -------------------------- */
    const rerunOut = await mfh(['run', '--config', configPath, '--state', statePath, '--concurrency', '2']);
    if (!/Run complete: processed=0, partial=0, skipped=3, failed=0/.test(rerunOut)) {
      fail(`重复 run 应全部跳过，不应重新处理：\n${rerunOut}`);
    }
    const archivedAfterRerun = (await readdir(cfg.paths.invoices)).filter((name) => name.toLowerCase().endsWith('.pdf')).sort();
    if (archivedAfterRerun.join('|') !== archived.join('|')) {
      fail(`重复 run 制造了重复归档文件：${JSON.stringify(archivedAfterRerun)}`);
    }
    const ledgerAfterRerun = await readCsv(cfg.output.csv);
    if (ledgerAfterRerun.rows.length !== 2) {
      fail(`重复 run 向 invoices.csv 追加了重复行，实际 ${ledgerAfterRerun.rows.length} 行`);
    }

    /* ---------- Stage 3: `mfh ocr run` — queue, results, checkpoints ------- */
    const ocrPendingPath = join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
    const queueBefore = await readCsv(ocrPendingPath);
    if (queueBefore.rows.length !== 2 || !queueBefore.rows.every((row) => row.status === 'pending')) {
      fail(`识别队列在识别前应是 2 行 pending：${JSON.stringify(queueBefore.rows)}`);
    }
    if (!queueBefore.header.includes('contentHash')) {
      fail(`识别队列必须携带 contentHash（APP-06B）：${queueBefore.header.join(',')}`);
    }

    const ocrOut = await mfh(['ocr', 'run', '--config', configPath, '--single-item']);
    if (!/OCR complete: scanned=2, parsed=2, skipped=0, failed=0/.test(ocrOut)) {
      fail(`真实 CLI ocr run 的汇总不符合预期：\n${ocrOut}`);
    }

    const results = await readCsv(cfg.ocr.resultsCsv);
    if (results.rows.length !== 2) fail(`ocr-results.csv 应有 2 行，实际 ${results.rows.length}`);
    if (!results.rows.every((row) => row.status === 'success')) {
      fail(`识别结果应全部成功：${JSON.stringify(results.rows.map((r) => r.status))}`);
    }
    if (!results.rows.every((row) => row.contentHash)) {
      fail('识别结果行必须回写 contentHash，供下游做身份校验');
    }
    const ledgerHashes = new Set(ledger.rows.map((row) => row.contentHash));
    if (!results.rows.every((row) => ledgerHashes.has(row.contentHash))) {
      fail(`识别结果的 contentHash 与归档台账对不上：${JSON.stringify(results.rows.map((r) => r.contentHash))}`);
    }
    const invoiceResult = results.rows.find((row) => row.documentType === 'invoice');
    if (!invoiceResult || !invoiceResult.seller || !invoiceResult.amount || !invoiceResult.invoiceNo) {
      fail(`发票识别结果缺少关键字段：${JSON.stringify(invoiceResult)}`);
    }

    const queueAfter = await readCsv(ocrPendingPath);
    if (!queueAfter.rows.every((row) => row.status === 'recognized')) {
      fail(`识别完成后队列状态应更新为 recognized：${JSON.stringify(queueAfter.rows.map((r) => r.status))}`);
    }

    const summaryOut = await mfh(['ocr', 'summary', '--config', configPath]);
    if (!/recognized=2 failed=0 ignored=0 pending=0/.test(summaryOut)) {
      fail(`ocr summary 与真实结果不一致：\n${summaryOut}`);
    }

    /* ---------- Stage 4: `mfh organize --apply-rename` --------------------- */
    const organizeOut = await mfh(['organize', '--config', configPath, '--apply-rename']);
    if (!/Organize complete: scanned=2, copied=2, skipped=0, failed=0/.test(organizeOut)) {
      fail(`真实 CLI organize 的汇总不符合预期：\n${organizeOut}`);
    }
    const organized = (await readdir(cfg.rename.organizedDir)).filter((name) => name.toLowerCase().endsWith('.pdf'));
    if (organized.length !== 2) fail(`整理输出应有 2 个文件，实际 ${JSON.stringify(organized)}`);
    // rename.rule = {seller}-{amount}.pdf must actually be applied.
    const expectedInvoiceName = `${invoiceResult.seller}-${invoiceResult.amount}.pdf`;
    if (!organized.includes(expectedInvoiceName)) {
      fail(`改名规则没有生效，期望 ${expectedInvoiceName}，实际 ${JSON.stringify(organized)}`);
    }
    const organizedBytes = await readFile(join(cfg.rename.organizedDir, expectedInvoiceName));
    if (!organizedBytes.equals(INVOICE_PDF)) fail('整理后的文件内容与原始附件不一致');
    const organizeLedger = await readCsv(join(cfg.rename.organizedDir, 'organize-results.csv'));
    if (organizeLedger.rows.length !== 2 || !organizeLedger.rows.every((row) => row.status === 'copied')) {
      fail(`organize-results.csv 没有如实记录整理结果：${JSON.stringify(organizeLedger.rows)}`);
    }

    // Archiving must never destroy the originals it copied from.
    for (const name of archived) {
      const info = await stat(join(cfg.paths.invoices, name));
      if (info.size === 0) fail(`整理之后归档原件 ${name} 变成了空文件`);
    }
  });
}

await runSuite('CLI integration (real compiled CLI)', main, { timeoutMs: 3 * 60 * 1000 });
