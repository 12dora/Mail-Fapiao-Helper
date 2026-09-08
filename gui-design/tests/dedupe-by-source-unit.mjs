import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDedupeArgs } from '../../dist/cli/args.js';
import { runDedupe } from '../../dist/cli/dedupe.js';
import { loadConfig } from '../../dist/config.js';
import { INVOICE_CSV_HEADER, OCR_CSV_HEADER } from '../../dist/pipeline/csvDurability.js';
import { contentHash } from '../../dist/util/hash.js';
import { readCsvRows, rewriteCsvRows } from '../../dist/util/csv.js';
import { repoRoot, withTempDir } from './_shared.mjs';

assert.equal(parseDedupeArgs([]).by, 'container');
assert.equal(parseDedupeArgs(['--by', 'source']).by, 'source');
assert.equal(parseDedupeArgs(['--by', 'source']).apply, false);
assert.throws(
  () => parseDedupeArgs(['--by', 'invalid']),
  { message: '--by must be container or invoice-no or source' },
);

const HTTP_SOURCE = 'https://dppt.shanghai.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&id=abc';
const ATTACH_SOURCE = '增值税电子发票.pdf';
const DUP_MESSAGE = '<dup@example.com>';

function ledgerRow(filename, messageId, source, hash, extra = {}) {
  return {
    messageId,
    date: '2026-05-21',
    from: 'tax@example.com',
    subject: '电子发票',
    filename,
    source,
    contentHash: hash,
    mailHash: messageId === DUP_MESSAGE ? 'mailhashdup1' : 'mailhashother',
    ...extra,
  };
}

function pendingRow(filename, messageId, source, hash) {
  return {
    hash: messageId === DUP_MESSAGE ? 'mailhashdup1' : 'mailhashother',
    messageId,
    date: '2026-05-21',
    from: 'tax@example.com',
    subject: '电子发票',
    filename,
    source,
    format: 'pdf',
    documentType: 'invoice',
    status: 'pending',
    reason: '',
    contentHash: hash,
  };
}

function filenames(file) {
  return readCsvRows(file).map((row) => row.filename).sort();
}

await withTempDir('mfh-dedupe-by-source-', async (dir) => {
  const cfg = loadConfig(path.join(repoRoot, 'config.example.json'));
  cfg.paths.invoices = path.join(dir, 'invoices');
  cfg.output.csv = path.join(dir, 'invoices.csv');
  cfg.ocr.resultsCsv = path.join(dir, 'ocr-results.csv');
  const pendingCsv = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  fs.mkdirSync(path.dirname(pendingCsv), { recursive: true });

  const files = [
    { filename: '0940.pdf', messageId: DUP_MESSAGE, source: HTTP_SOURCE, payload: Buffer.from('dup-later-a') },
    { filename: '0918.pdf', messageId: DUP_MESSAGE, source: HTTP_SOURCE, payload: Buffer.from('dup-earliest') },
    { filename: '0955.pdf', messageId: DUP_MESSAGE, source: HTTP_SOURCE, payload: Buffer.from('dup-later-b') },
    { filename: '1001.pdf', messageId: DUP_MESSAGE, source: ATTACH_SOURCE, payload: Buffer.from('attach-one') },
    { filename: '1002.pdf', messageId: DUP_MESSAGE, source: ATTACH_SOURCE, payload: Buffer.from('attach-two') },
    { filename: '2001.pdf', messageId: '<other@example.com>', source: HTTP_SOURCE, payload: Buffer.from('unrelated') },
  ];
  const rows = [];
  const pending = [];
  for (const item of files) {
    const hash = contentHash(item.payload);
    fs.writeFileSync(path.join(cfg.paths.invoices, item.filename), item.payload);
    rows.push(ledgerRow(item.filename, item.messageId, item.source, hash));
    pending.push(pendingRow(item.filename, item.messageId, item.source, hash));
  }
  rewriteCsvRows(cfg.output.csv, INVOICE_CSV_HEADER, rows);
  rewriteCsvRows(pendingCsv, OCR_CSV_HEADER, pending);
  const ledgerBefore = fs.readFileSync(cfg.output.csv);
  const pendingBefore = fs.readFileSync(pendingCsv);
  const bytesBefore = Object.fromEntries(files.map((item) => [
    item.filename,
    fs.readFileSync(path.join(cfg.paths.invoices, item.filename)),
  ]));

  const dry = runDedupe(cfg, { apply: false, by: 'source' }, dir);
  assert.equal(dry.mode, 'source');
  assert.equal(dry.applied, false);
  assert.equal(dry.quarantineDir, null);
  assert.equal(dry.groups.length, 1);
  assert.equal(dry.pairs, 1);
  assert.equal(dry.redundant, 2);
  assert.equal(dry.quarantined, 0);
  assert.equal(dry.ledgerRowsRemoved, 0);
  assert.equal(dry.ocrRowsRemoved, 0);
  const [group] = dry.groups;
  assert.equal(group.messageId, DUP_MESSAGE);
  assert.equal(group.source, HTTP_SOURCE);
  assert.equal(group.kept.filename, '0918.pdf');
  assert.deepEqual(group.removed.map((row) => row.filename), ['0940.pdf', '0955.pdf']);
  assert.deepEqual(fs.readFileSync(cfg.output.csv), ledgerBefore);
  assert.deepEqual(fs.readFileSync(pendingCsv), pendingBefore);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '.dedupe-quarantine')), false);
  for (const item of files) {
    assert.deepEqual(fs.readFileSync(path.join(cfg.paths.invoices, item.filename)), bytesBefore[item.filename]);
  }

  const applied = runDedupe(cfg, { apply: true, by: 'source' }, dir);
  assert.equal(applied.mode, 'source');
  assert.equal(applied.applied, true);
  assert.equal(applied.groups.length, 1);
  assert.equal(applied.groups[0].kept.filename, '0918.pdf');
  assert.deepEqual(applied.groups[0].removed.map((row) => row.filename), ['0940.pdf', '0955.pdf']);
  assert.equal(applied.quarantined, 2);
  assert.equal(applied.ledgerRowsRemoved, 2);
  assert.equal(applied.ocrRowsRemoved, 2);
  assert.equal(applied.quarantineDir.split(/[\\/]/).at(-1), 'by-source');
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0918.pdf')), true);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0940.pdf')), false);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0955.pdf')), false);
  assert.deepEqual(
    fs.readdirSync(applied.quarantineDir).sort(),
    ['0940.pdf', '0955.pdf'],
  );
  assert.deepEqual(fs.readFileSync(path.join(applied.quarantineDir, '0940.pdf')), bytesBefore['0940.pdf']);
  assert.deepEqual(fs.readFileSync(path.join(applied.quarantineDir, '0955.pdf')), bytesBefore['0955.pdf']);
  assert.deepEqual(filenames(cfg.output.csv), ['0918.pdf', '1001.pdf', '1002.pdf', '2001.pdf']);
  assert.deepEqual(filenames(pendingCsv), ['0918.pdf', '1001.pdf', '1002.pdf', '2001.pdf']);
  const leftover = readCsvRows(cfg.output.csv);
  assert.deepEqual(
    leftover.filter((row) => row.source === ATTACH_SOURCE).map((row) => row.filename).sort(),
    ['1001.pdf', '1002.pdf'],
  );
  assert.equal(leftover.some((row) => row.filename === '2001.pdf' && row.source === HTTP_SOURCE), true);

  const ledgerAfter = fs.readFileSync(cfg.output.csv);
  const pendingAfter = fs.readFileSync(pendingCsv);
  const again = runDedupe(cfg, { apply: true, by: 'source' }, dir);
  assert.equal(again.mode, 'source');
  assert.equal(again.groups.length, 0);
  assert.equal(again.redundant, 0);
  assert.equal(again.quarantined, 0);
  assert.equal(again.ledgerRowsRemoved, 0);
  assert.equal(again.ocrRowsRemoved, 0);
  assert.equal(again.quarantineDir, null);
  assert.deepEqual(fs.readFileSync(cfg.output.csv), ledgerAfter);
  assert.deepEqual(fs.readFileSync(pendingCsv), pendingAfter);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '0918.pdf')), true);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '1001.pdf')), true);
  assert.equal(fs.existsSync(path.join(cfg.paths.invoices, '1002.pdf')), true);
});

console.log('dedupe-by-source unit tests passed');
