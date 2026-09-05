import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../dist/config.js';
import { runOcrPending } from '../../dist/ocr/runner.js';
import { readCsvRows } from '../../dist/util/csv.js';
import { repoRoot, withTempDir } from './_shared.mjs';
import { okResult } from '../../dist/ocr/efapiao/result.js';
import { createMockOcrProvider } from '../../dist/ocr/mockProvider.js';
import { isSupportingDocument, withDocumentClassification } from '../../dist/extract/classify.js';

for (const format of ['pdf', 'ofd', 'image']) {
  for (const invoiceType of ['toll_summary', 'order_detail', 'settlement', 'supporting_other']) {
    for (const nested of [false, true]) {
      const classification = { document_type: `${format}-supporting`, invoice_type: invoiceType };
      const payload = {
        status: 'ok', ...(nested ? {} : classification),
        data: {
          ...(nested ? classification : {}),
          extra: { title: '汇总材料', related_invoice_numbers: ['1234567890'] },
          invoice_number: '1234567890', seller: { name: 'Not an invoice seller' },
        },
      };
      const result = okResult(payload, 'invoice', 'http');
      assert.deepEqual(result.fields, {
        documentType: 'supporting', invoiceType, seller: '汇总材料', amount: '', date: '', invoiceNo: '',
      });
      assert.equal(result.status, 'success');
      assert.equal(result.error, '');
      assert.equal(result.transport, 'http');
      assert.deepEqual(result.raw.data.extra.related_invoice_numbers, ['1234567890']);
    }
  }
  const result = await createMockOcrProvider().parse(Buffer.from('fixture'), {
    filename: 'mock-supporting', format, documentType: 'invoice',
  });
  assert.equal(result.fields.documentType, 'supporting');
  assert.equal(result.status, 'success');
  assert.equal(isSupportingDocument({ filename: '订单明细.pdf', format, documentType: 'invoice' }), true);
}
assert.equal(okResult({ status: 'ok', document_type: 'pdf-supporting' }, 'invoice', 'cli').status, 'success');
assert.equal(okResult({ status: 'ok', document_type: 'pdf-fapiao' }, 'supporting', 'cli').fields.documentType, 'supporting');
assert.equal(okResult({ status: 'ok', document_type: 'pdf-fapiao' }, 'invoice', 'cli').status, 'partial');
assert.equal(isSupportingDocument({ filename: '航空运输电子客票行程单.pdf' }), false);
assert.equal(withDocumentClassification({ data: Buffer.alloc(0), source: '', documentType: 'supporting' }, 'pdf').requiresOcr, false);
console.log('OCR supporting mapping unit tests passed');

await withTempDir('mfh-ocr-supporting-', async (dir) => {
  const cfg = loadConfig(path.join(repoRoot, 'config.example.json'));
  cfg.paths.invoices = path.join(dir, 'invoices');
  cfg.ocr.resultsCsv = path.join(dir, 'results.csv');
  cfg.ocr.enabled = true;
  cfg.ocr.provider = 'mock';
  const queue = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  fs.mkdirSync(path.dirname(queue), { recursive: true });
  fs.writeFileSync(path.join(cfg.paths.invoices, 'mock-supporting.pdf'), '%PDF-1.4');
  fs.writeFileSync(queue, 'hash,filename,source,format,documentType,status\ncontent,mock-supporting.pdf,attachment.pdf,pdf,invoice,pending\nname,old.pdf,订单明细.pdf,pdf,invoice,pending\n');
  const previous = process.env.MFH_ALLOW_MOCK_OCR;
  process.env.MFH_ALLOW_MOCK_OCR = '1';
  try {
    const log = { info() {}, warn() {}, debug() {}, error() {} };
    const summary = await runOcrPending(cfg, log);
    assert.equal(summary.failed, 0);
    assert.equal(summary.parsed, 1);
    assert.equal(summary.skipped, 1);
    const [result] = readCsvRows(cfg.ocr.resultsCsv);
    assert.equal(result.documentType, 'supporting');
    assert.equal(result.invoiceType, 'toll_summary');
    assert.equal(result.status, 'success');
    assert.equal(result.error, '');
    assert.equal(result.seller, '收费公路通行费电子票据汇总单');
    assert.equal(result.invoiceNo, '');
    assert.deepEqual(readCsvRows(queue).map(row => row.documentType), ['supporting', 'supporting']);
    const rerun = await runOcrPending(cfg, log, { force: true });
    assert.equal(rerun.parsed, 0);
    assert.equal(rerun.skipped, 2);
  } finally {
    if (previous === undefined) delete process.env.MFH_ALLOW_MOCK_OCR;
    else process.env.MFH_ALLOW_MOCK_OCR = previous;
  }
});
