import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseOcrArgs } from '../../dist/cli/args.js';
import { loadConfig } from '../../dist/config.js';
import { runOcrPending } from '../../dist/ocr/runner.js';
import { readCsvRows } from '../../dist/util/csv.js';
import { repoRoot, withTempDir } from './_shared.mjs';

const parsed = parseOcrArgs(['run', '--retry-failed']);
assert.equal(parsed.retryFailed, true);
assert.equal(parsed.force, false);
assert.equal(parsed.command, 'run');

assert.throws(
  () => parseOcrArgs(['run', '--retry-failed', '--force']),
  { message: '--retry-failed cannot be combined with --force' },
);
assert.throws(
  () => parseOcrArgs(['run', '--force', '--retry-failed']),
  { message: '--retry-failed cannot be combined with --force' },
);

const PENDING_HEADER = [
  'hash', 'messageId', 'date', 'from', 'subject', 'filename', 'source',
  'format', 'documentType', 'status', 'reason', 'contentHash',
];
const RESULT_HEADER = [
  'hash', 'messageId', 'date', 'from', 'subject', 'filename', 'source', 'format',
  'documentType', 'invoiceType', 'seller', 'amount', 'dateValue', 'invoiceNo',
  'transport', 'extractedBy', 'parserVersion', 'ocrVendor', 'status', 'error', 'contentHash',
];

function csv(header, rows) {
  const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return `${header.join(',')}\n${rows.map((row) => header.map((key) => cell(row[key])).join(',')).join('\n')}\n`;
}

function pendingRow(filename, status, reason) {
  return {
    hash: filename === 'ok.pdf' ? 'hash-ok' : 'hash-bad',
    messageId: '<retry@example.com>',
    date: '2026-05-21',
    from: 'vendor@example.com',
    subject: '发票',
    filename,
    source: filename,
    format: 'pdf',
    documentType: 'invoice',
    status,
    reason,
    contentHash: '',
  };
}

function resultRow(filename, status, extra = {}) {
  return {
    hash: filename === 'ok.pdf' ? 'hash-ok' : 'hash-bad',
    messageId: '<retry@example.com>',
    date: '2026-05-21',
    from: 'vendor@example.com',
    subject: '发票',
    filename,
    source: filename,
    format: 'pdf',
    documentType: 'invoice',
    invoiceType: '电子发票',
    seller: status === 'success' ? 'KEEP-SUCCESS-SELLER' : '',
    amount: status === 'success' ? '1.00' : '',
    dateValue: status === 'success' ? '2026-05-21' : '',
    invoiceNo: status === 'success' ? 'KEEP-NO' : '',
    transport: 'http',
    extractedBy: 'text_layer',
    parserVersion: 'fixture',
    ocrVendor: '',
    status,
    error: status === 'error' ? 'efapiao_timeout' : '',
    contentHash: '',
    ...extra,
  };
}

function silentLog(lines = []) {
  return {
    info(message) { lines.push(String(message)); },
    warn() {},
    debug() {},
    error() {},
  };
}

async function withOcrFixture(body) {
  await withTempDir('mfh-ocr-retry-failed-', async (dir) => {
    const cfg = loadConfig(path.join(repoRoot, 'config.example.json'));
    cfg.paths.invoices = path.join(dir, 'invoices');
    cfg.ocr.resultsCsv = path.join(dir, 'ocr-results.csv');
    cfg.ocr.enabled = true;
    cfg.ocr.provider = 'mock';
    const queue = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
    fs.mkdirSync(path.dirname(queue), { recursive: true });
    fs.writeFileSync(path.join(cfg.paths.invoices, 'ok.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(cfg.paths.invoices, 'bad.pdf'), '%PDF-1.4');
    fs.writeFileSync(queue, csv(PENDING_HEADER, [
      pendingRow('ok.pdf', 'recognized', ''),
      pendingRow('bad.pdf', 'failed', 'efapiao_timeout'),
    ]));
    fs.writeFileSync(cfg.ocr.resultsCsv, csv(RESULT_HEADER, [
      resultRow('ok.pdf', 'success'),
      resultRow('bad.pdf', 'error'),
    ]));
    const previous = process.env.MFH_ALLOW_MOCK_OCR;
    process.env.MFH_ALLOW_MOCK_OCR = '1';
    try {
      await body({ cfg, queue });
    } finally {
      if (previous === undefined) delete process.env.MFH_ALLOW_MOCK_OCR;
      else process.env.MFH_ALLOW_MOCK_OCR = previous;
    }
  });
}

await withOcrFixture(async ({ cfg, queue }) => {
  const summary = await runOcrPending(cfg, silentLog());
  assert.equal(summary.parsed, 0);
  assert.equal(summary.skipped, 2);
  const results = readCsvRows(cfg.ocr.resultsCsv);
  assert.deepEqual(results.map((row) => [row.filename, row.status, row.seller, row.error]), [
    ['ok.pdf', 'success', 'KEEP-SUCCESS-SELLER', ''],
    ['bad.pdf', 'error', '', 'efapiao_timeout'],
  ]);
  const failed = readCsvRows(queue).find((row) => row.filename === 'bad.pdf');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'efapiao_timeout');
});

await withOcrFixture(async ({ cfg, queue }) => {
  const lines = [];
  const summary = await runOcrPending(cfg, silentLog(lines), { retryFailed: true });
  assert.equal(summary.parsed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.ok(
    lines.includes('OCR retry-failed: dropped 1 failed result rows'),
    `missing retry log: ${JSON.stringify(lines)}`,
  );
  const results = readCsvRows(cfg.ocr.resultsCsv);
  const byName = new Map(results.map((row) => [row.filename, row]));
  assert.equal(byName.get('ok.pdf').status, 'success');
  assert.equal(byName.get('ok.pdf').seller, 'KEEP-SUCCESS-SELLER');
  assert.equal(byName.get('ok.pdf').invoiceNo, 'KEEP-NO');
  assert.equal(byName.get('bad.pdf').status, 'success');
  assert.equal(byName.get('bad.pdf').seller, '国家电网有限公司');
  assert.equal(byName.get('bad.pdf').error, '');
  assert.equal(results.filter((row) => row.status === 'error').length, 0);
  const queueRows = Object.fromEntries(readCsvRows(queue).map((row) => [row.filename, row]));
  assert.equal(queueRows['ok.pdf'].status, 'recognized');
  assert.equal(queueRows['bad.pdf'].status, 'recognized');
});

console.log('OCR retry-failed unit tests passed');
