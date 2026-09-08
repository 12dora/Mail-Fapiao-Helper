import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../dist/config.js';
import { INVOICE_CSV_HEADER, OCR_CSV_HEADER } from '../../dist/pipeline/csvDurability.js';
import { organizeFromOcrResults } from '../../dist/rename/rename.js';
import { contentHash } from '../../dist/util/hash.js';
import { rewriteCsvRows } from '../../dist/util/csv.js';
import { repoRoot, withTempDir } from './_shared.mjs';

// 整理按类型分文件夹：发票进「发票」、附属材料进「附属材料」并保留原始文件名。
const RESULT_HEADER = 'hash,messageId,date,from,subject,filename,source,format,documentType,invoiceType,seller,amount,dateValue,invoiceNo,transport,extractedBy,parserVersion,ocrVendor,status,error,contentHash';
const silent = { info() {}, warn() {}, debug() {}, error() {} };

function base(filename, source, documentType) {
  return { hash: 'mh1', messageId: '<m1@example.com>', date: '2026-04-22T00:00:00.000Z', from: 'a@example.com', subject: '发票', filename, source, format: 'pdf', documentType };
}

await withTempDir('mfh-organize-types-', async (dir) => {
  const cfg = loadConfig(path.join(repoRoot, 'config.example.json'));
  cfg.paths.invoices = path.join(dir, 'invoices');
  cfg.output.csv = path.join(dir, 'invoices.csv');
  cfg.ocr.resultsCsv = path.join(dir, 'ocr-results.csv');
  cfg.rename.organizedDir = path.join(dir, 'organized');
  cfg.rename.organizeByType = true;
  cfg.rename.typeDirRule = '{typeLabel}';
  cfg.rename.applyAfterOcr = true;
  cfg.rename.rule = '{seller}-{amount}.pdf';
  cfg.rename.fallback = '{date}-{originalName}';
  const pendingCsv = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  fs.mkdirSync(path.dirname(pendingCsv), { recursive: true });
  const docs = [
    { ...base('0001.pdf', 'dzfp_26312000000000000001_国家电网.pdf', 'invoice'), seller: '国家电网有限公司', amount: '318.42', invoiceNo: '26312000000000000001' },
    { ...base('0002.pdf', 'https://cdn.example.com/files/elfp123.pdf?token=abc', 'invoice'), seller: '', amount: '', invoiceNo: '' },
    { ...base('0003.pdf', '通行费电子发票.zip/通行费电子票据汇总单(票据).pdf', 'supporting') },
    { ...base('0004.pdf', 'https://cdn.example.com/x/26317000001452019848.pdf', 'invoice'), date: '', seller: '', amount: '', invoiceNo: '' },
  ];
  const ledger = []; const pending = []; const results = [];
  for (const doc of docs) {
    const payload = Buffer.from(`%PDF-1.4 ${doc.filename}`);
    fs.writeFileSync(path.join(cfg.paths.invoices, doc.filename), payload);
    const hash = contentHash(payload);
    ledger.push({ messageId: doc.messageId, date: doc.date, from: doc.from, subject: doc.subject, filename: doc.filename, source: doc.source, contentHash: hash, mailHash: 'mh1' });
    pending.push({ ...doc, status: doc.documentType === 'supporting' ? 'ignored' : 'recognized', reason: doc.documentType === 'supporting' ? 'supporting_document:toll_summary' : '', contentHash: hash });
    if (doc.documentType !== 'supporting') {
      results.push({ ...doc, invoiceType: 'digital_general', dateValue: doc.date ? '2026-04-22' : '', transport: 'http', extractedBy: 'text_layer', parserVersion: '0.1.0', ocrVendor: '', status: 'success', error: '', contentHash: hash });
    }
  }
  rewriteCsvRows(cfg.output.csv, INVOICE_CSV_HEADER, ledger);
  rewriteCsvRows(pendingCsv, OCR_CSV_HEADER, pending);
  rewriteCsvRows(cfg.ocr.resultsCsv, RESULT_HEADER, results);

  const summary = organizeFromOcrResults(cfg, silent);
  assert.equal(summary.copied, 4, JSON.stringify(summary));
  const out = cfg.rename.organizedDir;
  assert.equal(fs.existsSync(path.join(out, '发票', '26317000001452019848.pdf')), true, '日期为空时不留开头的短横线');
  assert.equal(fs.existsSync(path.join(out, '发票', '国家电网有限公司-318.42.pdf')), true, '发票按卖方-金额命名进「发票」');
  assert.equal(fs.existsSync(path.join(out, '发票', '2026-04-22-elfp123.pdf')), true, '缺字段的发票走回退名，原始名取自链接末段');
  assert.equal(fs.existsSync(path.join(out, '附属材料', '2026-04-22-通行费电子票据汇总单(票据).pdf')), true, '附属材料 = 邮件日期 + 原始文件名');
  assert.equal(fs.existsSync(path.join(out, 'supporting')), false);

  // 平铺模式：附属材料仍默认跳过
  cfg.rename.organizeByType = false;
  cfg.rename.organizedDir = path.join(dir, 'flat');
  const flat = organizeFromOcrResults(cfg, silent);
  assert.equal(flat.copied, 3);
  assert.equal(fs.existsSync(path.join(cfg.rename.organizedDir, '2026-04-22-通行费电子票据汇总单(票据).pdf')), false, '平铺模式不整理附属材料');
});

console.log('organize-type-folders-unit: passed');
