import assert from 'node:assert/strict';
import { invoiceNumbersIn, isProbeNoise, probeFailureCouldBeInvoice } from '../../dist/extract/assetEvidence.js';

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

// 税务局查验 / 数电票交付页从来不是直接下载，探测都不必做。
for (const url of [
  'https://inv-veri.chinatax.gov.cn/',
  'https://dppt.shanghai.chinatax.gov.cn:8443/v/2_26312000001432309111_202603092029050078C17E',
  'not a url',
]) assert.equal(isProbeNoise(url), true, `should be probe noise: ${url}`);
for (const url of [
  'https://etd.kpbyd.com/hub/files/download?code=abc',
  'https://chinatax.example.com/x.pdf',
  // 同一税务局域名下的导出接口是真下载，不能当噪音
  'https://dppt.shanghai.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&Fphm=26312000001432309111',
]) assert.equal(isProbeNoise(url), false, `should be probed: ${url}`);

assert.deepEqual(invoiceNumbersIn('directLink:probe_failed:HEAD:https://dppt.shanghai.chinatax.gov.cn:8443/v/2_26312000001432309111_2026:http_511'), ['26312000001432309111']);
assert.deepEqual(invoiceNumbersIn('dzfp_26952000003588694681_%E6%B5%99%E6%B1%9F_20260824.pdf'), ['26952000003588694681']);
assert.deepEqual(invoiceNumbersIn('/v/2_26312000001432309111_26312000001432309111'), ['26312000001432309111']);
assert.deepEqual(invoiceNumbersIn('123456789012345678901'), []);
assert.deepEqual(invoiceNumbersIn(undefined), []);
console.log('link-evidence-unit: passed');
