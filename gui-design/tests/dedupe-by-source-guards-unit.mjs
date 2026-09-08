import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDedupe } from '../../dist/cli/dedupe.js';
import { loadConfig } from '../../dist/config.js';
import { INVOICE_CSV_HEADER, OCR_CSV_HEADER } from '../../dist/pipeline/csvDurability.js';
import { contentHash } from '../../dist/util/hash.js';
import { readCsvRows, rewriteCsvRows } from '../../dist/util/csv.js';
import { repoRoot, withTempDir } from './_shared.mjs';

// codex 复审两条护栏：keeper 必须先验明正身；被别的台账行引用的文件不能隔离。
const SRC = 'https://dppt.shanghai.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&Fphm=26312000001432309111';
const MSG = '<guards@example.com>';

function row(filename, messageId, source, hash) {
  return { messageId, date: '2026-05-21', from: 'tax@example.com', subject: '电子发票', filename, source, contentHash: hash, mailHash: 'mh1' };
}
function ocrRow(filename, messageId, source, hash) {
  return { hash: 'mh1', messageId, date: '2026-05-21', from: 'tax@example.com', subject: '电子发票', filename, source, format: 'pdf', documentType: 'invoice', status: 'pending', reason: '', contentHash: hash };
}

await withTempDir('mfh-dedupe-guards-', async (dir) => {
  const cfg = loadConfig(path.join(repoRoot, 'config.example.json'));
  cfg.paths.invoices = path.join(dir, 'invoices');
  cfg.output.csv = path.join(dir, 'invoices.csv');
  cfg.ocr.resultsCsv = path.join(dir, 'ocr-results.csv');
  const pendingCsv = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  fs.mkdirSync(path.dirname(pendingCsv), { recursive: true });

  const payload = (name) => Buffer.from(`pdf-${name}`);
  const rows = [];
  const ocr = [];
  // 0100：序号最早但文件不在磁盘上 → 不能当 keeper
  rows.push(row('0100.pdf', MSG, SRC, contentHash(payload('0100'))));
  // 0101：第一份能验证的 → keeper
  for (const name of ['0101', '0102', '0103']) {
    fs.writeFileSync(path.join(cfg.paths.invoices, `${name}.pdf`), payload(name));
    rows.push(row(`${name}.pdf`, MSG, SRC, contentHash(payload(name))));
    ocr.push(ocrRow(`${name}.pdf`, MSG, SRC, contentHash(payload(name))));
  }
  // 0102 同时被另一封邮件的行引用（字节相同时复用同一份归档）→ 不能隔离
  rows.push(row('0102.pdf', '<other@example.com>', 'https://other.example.com/x?Fphm=26312000001432309111', contentHash(payload('0102'))));
  rewriteCsvRows(cfg.output.csv, INVOICE_CSV_HEADER, rows);
  rewriteCsvRows(pendingCsv, OCR_CSV_HEADER, ocr);

  const dry = runDedupe(cfg, { apply: false, by: 'source' }, dir);
  assert.equal(dry.groups.length, 1);
  assert.equal(dry.groups[0].kept.filename, '0101.pdf', '缺失的 0100 不能当 keeper');
  assert.deepEqual(dry.groups[0].removed.map((r) => r.filename), ['0103.pdf']);
  assert.deepEqual(dry.skipped.map((s) => s.filename).sort(), ['0100.pdf', '0102.pdf']);
  assert.ok(dry.skipped.find((s) => s.filename === '0102.pdf').reason.includes('another ledger row'));

  const applied = runDedupe(cfg, { apply: true, by: 'source' }, dir);
  assert.equal(applied.quarantined, 1);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0101.pdf')), true);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0102.pdf')), true, '被别的行引用的文件必须保留');
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0103.pdf')), false);
  const ledgerAfter = readCsvRows(cfg.output.csv).map((r) => `${r.filename}|${r.messageId}`).sort();
  assert.deepEqual(ledgerAfter, ['0100.pdf|<guards@example.com>', '0101.pdf|<guards@example.com>', '0102.pdf|<guards@example.com>', '0102.pdf|<other@example.com>']);
  assert.deepEqual(readCsvRows(pendingCsv).map((r) => r.filename).sort(), ['0101.pdf', '0102.pdf']);
});

console.log('dedupe-by-source-guards-unit: passed');
