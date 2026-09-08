import assert from 'node:assert/strict';
import { probeFailureCouldBeInvoice } from '../../dist/extract/assetEvidence.js';

// EXT-13 补充：弱语义词只看路径/查询串，站点首页与邮件落地页一律不算发票入口。
const notInvoice = [
  // 真实案例：开票平台页脚的首页链接，票已从附件归档，它打不通不该把邮件压进待确认
  'https://ticket.download.xiaowangtech.com/index_email.html',
  'https://download.example.com/',
  'https://fapiao.example.com/index.html',
  'https://bill.example.com/home.php',
  'http://127.0.0.1:9/z_stat.php?id=1279',
  'http://127.0.0.1:9/msg.aw',
  'https://cdn.example.com/static/logo.png',
  'not a url',
];
const couldBeInvoice = [
  'http://127.0.0.1:9/invoice/download?id=1',
  'https://example.com/files/26422000003020022001.pdf',
  'https://example.com/download?fphm=26422000003020022001',
  'https://example.com/index.html?fphm=26422000003020022001',
  'https://example.com/receipt/export',
  'https://fapiao.example.com/view?token=abc',
  'https://example.com/e-ticket/123',
  'https://example.com/pack.zip',
];
for (const url of notInvoice) assert.equal(probeFailureCouldBeInvoice(url), false, `should be incidental: ${url}`);
for (const url of couldBeInvoice) assert.equal(probeFailureCouldBeInvoice(url), true, `should count as invoice entry: ${url}`);
console.log('link-evidence-unit: passed');
