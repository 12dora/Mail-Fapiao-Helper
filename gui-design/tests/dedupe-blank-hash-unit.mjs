import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDedupe } from '../../dist/cli/dedupe.js';
import { loadConfig } from '../../dist/config.js';
import { INVOICE_CSV_HEADER, OCR_CSV_HEADER } from '../../dist/pipeline/csvDurability.js';
import { contentHash } from '../../dist/util/hash.js';
import { readCsvRows, rewriteCsvRows } from '../../dist/util/csv.js';
import { repoRoot, withTempDir } from './_shared.mjs';

// 早期识别结果行没有 contentHash：invoice-no 去重要拿台账里的 hash 校验文件，而不是整组跳过。
const RESULT_HEADER = 'hash,messageId,date,from,subject,filename,source,format,documentType,invoiceType,seller,amount,dateValue,invoiceNo,transport,extractedBy,parserVersion,ocrVendor,status,error,contentHash';
const NO = '26337904680400308223';

function ledgerRow(filename, hash) {
  return { messageId: `<${filename}@example.com>`, date: '2026-04-22', from: 'toll@example.com', subject: '通行费', filename, source: `通行费电子发票.zip/${filename}`, contentHash: hash, mailHash: 'mh' + filename };
}
function ocrPendingRow(filename) {
  return { hash: 'mh' + filename, messageId: `<${filename}@example.com>`, date: '2026-04-22', from: 'toll@example.com', subject: '通行费', filename, source: `通行费电子发票.zip/${filename}`, format: 'pdf', documentType: 'invoice', status: 'recognized', reason: '', contentHash: '' };
}
function resultRow(filename) {
  return { hash: 'mh' + filename, messageId: `<${filename}@example.com>`, date: '2026-04-22', from: 'toll@example.com', subject: '通行费', filename, source: `通行费电子发票.zip/${filename}`, format: 'pdf', documentType: 'invoice', invoiceType: 'toll', seller: '某高速', amount: '12.00', dateValue: '2026-04-22', invoiceNo: NO, transport: 'http', extractedBy: 'text_layer', parserVersion: '0.1.0', ocrVendor: '', status: 'success', error: '', contentHash: '' };
}

await withTempDir('mfh-dedupe-blank-hash-', async (dir) => {
  const cfg = loadConfig(path.join(repoRoot, 'config.example.json'));
  cfg.paths.invoices = path.join(dir, 'invoices');
  cfg.output.csv = path.join(dir, 'invoices.csv');
  cfg.ocr.resultsCsv = path.join(dir, 'ocr-results.csv');
  const pendingCsv = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  fs.mkdirSync(path.dirname(pendingCsv), { recursive: true });
  const payload = Buffer.from('%PDF-1.4 same-toll-invoice');
  for (const name of ['0065.pdf', '0073.pdf']) fs.writeFileSync(path.join(cfg.paths.invoices, name), payload);
  rewriteCsvRows(cfg.output.csv, INVOICE_CSV_HEADER, [ledgerRow('0065.pdf', contentHash(payload)), ledgerRow('0073.pdf', contentHash(payload))]);
  rewriteCsvRows(pendingCsv, OCR_CSV_HEADER, [ocrPendingRow('0065.pdf'), ocrPendingRow('0073.pdf')]);
  rewriteCsvRows(cfg.ocr.resultsCsv, RESULT_HEADER, [resultRow('0065.pdf'), resultRow('0073.pdf')]);

  const dry = runDedupe(cfg, { apply: false, by: 'invoice-no' }, dir);
  assert.deepEqual(dry.skipped, [], '台账有 hash 时不能再报 keeper_unverified');
  assert.equal(dry.groups.length, 1);
  assert.equal(dry.groups[0].kept.filename, '0065.pdf');
  assert.deepEqual(dry.groups[0].removed.map((r) => r.filename), ['0073.pdf']);

  const applied = runDedupe(cfg, { apply: true, by: 'invoice-no' }, dir);
  assert.equal(applied.quarantined, 1);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0065.pdf')), true);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0073.pdf')), false);
  assert.deepEqual(readCsvRows(cfg.output.csv).map((r) => r.filename), ['0065.pdf']);
  assert.deepEqual(readCsvRows(cfg.ocr.resultsCsv).map((r) => r.filename), ['0065.pdf'], '空 hash 的结果行也要随文件一起剪掉');
  assert.deepEqual(readCsvRows(pendingCsv).map((r) => r.filename), ['0065.pdf']);
});

console.log('dedupe-blank-hash-unit: passed');
