import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMailStatusIndex, mailStatusFor } from '../../dist/electron/mailStatus.js';
import { currentOcrRows, detailLinkUrl, invoicePath, registerDetailHandlers } from '../../dist/electron/ipc/detailHandlers.js';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mfh-detail-'));
try {
  const cfg = { paths: { samples: 'samples', pending: 'pending', invoices: 'invoices' }, output: { csv: 'invoices.csv' }, ocr: { resultsCsv: 'ocr.csv' } };
  for (const dir of Object.values(cfg.paths)) fs.mkdirSync(path.join(cwd, dir));
  const hashes = ['a', 'b', 'c', 'd', 'e'].map(c => c.repeat(32));
  const [archived, pending, ignored, unprocessed, rawOnly] = hashes;
  fs.writeFileSync(path.join(cwd, 'state.json'), JSON.stringify({ processedHashes: [archived, pending, ignored], fetchedHashes: hashes.slice(0, 4) }));
  fs.writeFileSync(path.join(cwd, 'samples/INDEX.csv'), `mailHash,messageId\n${archived},<a>\n${unprocessed},<d>\n`);
  fs.writeFileSync(path.join(cwd, 'invoices.csv'), `mailHash,messageId,filename\n,<a>,a.pdf\n${archived},<a>,b.pdf\n`);
  fs.writeFileSync(path.join(cwd, 'pending/pending.csv'), `mailHash,messageId,reason\n${archived},<a>,no_pdf_links\n${pending},<b>,no_pdf_links\n`);
  fs.writeFileSync(path.join(cwd, `pending/${pending}.eml`), 'Subject: pending\r\n\r\nbody');
  fs.writeFileSync(path.join(cwd, `samples/${rawOnly}.eml`), 'Subject: raw\r\n\r\nbody');
  const index = buildMailStatusIndex(cfg, cwd);
  assert.deepEqual(mailStatusFor(index, archived), { status: 'archived', documentCount: 2, mailOpenable: false });
  assert.deepEqual(mailStatusFor(index, pending), { status: 'pending', documentCount: 0, mailOpenable: true });
  assert.equal(mailStatusFor(index, ignored).status, 'ignored');
  assert.equal(mailStatusFor(index, unprocessed).status, 'unprocessed');
  assert.equal(mailStatusFor(index, rawOnly).mailOpenable, true);
  assert.equal(mailStatusFor(index, 'f'.repeat(32)).status, 'unprocessed');
  const success = { filename: 'a.pdf', contentHash: 'one', status: 'success', seller: 'seller' };
  assert.deepEqual(currentOcrRows([success, { ...success, status: 'error' }, { ...success, contentHash: 'two', status: 'partial' }]), [success, { ...success, contentHash: 'two', status: 'partial' }]);
  const signed = 'https://example.com/invoice.pdf?token=short&x=1';
  assert.equal(detailLinkUrl(signed), signed);
  const hidden = new URL(detailLinkUrl(`https://example.com/invoice.pdf?token=${'x'.repeat(65)}&x=1`));
  assert.equal(hidden.searchParams.get('token'), '[已隐藏]');
  assert.equal(hidden.searchParams.get('x'), '1');
  const root = path.join(cwd, 'invoices');
  assert.equal(invoicePath(root, '../state.json'), undefined);
  assert.equal(invoicePath(root, path.join(cwd, 'state.json')), undefined);
  fs.symlinkSync(path.join(cwd, 'state.json'), path.join(root, 'escape.pdf'));
  assert.equal(invoicePath(root, 'escape.pdf'), undefined);
  fs.symlinkSync(path.join(cwd, 'pending'), path.join(root, 'escape-dir'));
  assert.equal(invoicePath(root, 'escape-dir/missing.pdf'), undefined);

  // A sparse oversized EML must fail before mailparser reads its body.
  const large = 'f'.repeat(32);
  const file = path.join(cwd, `samples/${large}.eml`);
  const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd);
  const handlers = new Map();
  registerDetailHandlers({ handleTrusted: (name, fn) => handlers.set(name, fn), readConfigForPaths: () => cfg, realDataDir: () => cwd, ledgerCsvPath: () => path.join(cwd, 'invoices.csv'), invoicesDirPath: () => root, appSummary: () => ({}), resolveOpenTarget: target => ({ ok: true, path: target }) });
  assert.equal((await handlers.get('mfh:mail-detail')({}, { hash: large })).code, 'eml_unreadable');
  const many = '9'.repeat(32);
  const parts = Array.from({ length: 55 }, (_, i) => `--boundary\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="${i}.pdf"\r\n\r\npdf${i}\r\n`).join('');
  fs.writeFileSync(path.join(cwd, `samples/${many}.eml`), `Subject: caps\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="boundary"\r\n\r\n--boundary\r\nContent-Type: text/plain\r\n\r\n${Array.from({ length: 55 }, (_, i) => `https://example.com/${i}.pdf`).join('\n')}\r\n${parts}--boundary--\r\n`);
  const capped = await handlers.get('mfh:mail-detail')({}, { hash: many });
  assert.equal(capped.ok, true);
  assert.equal(capped.mail.attachments.length, 50);
  assert.equal(capped.mail.links.length, 50);
  assert.equal(capped.mail.bodyLinkCount, 55);
  // Saved samples take precedence over the pending copy for the same mail.
  fs.writeFileSync(path.join(cwd, `samples/${pending}.eml`), 'Subject: saved copy\r\n\r\nhttps://example.com/invoice.pdf https://example.com/banner.png https://inv-veri.chinatax.gov.cn/check');
  const preferred = await handlers.get('mfh:mail-detail')({}, { hash: pending });
  assert.equal(preferred.ok, true);
  assert.equal(preferred.mail.emlLocation, 'samples');
  assert.deepEqual(preferred.mail.links.map(link => link.url), ['https://example.com/invoice.pdf']);

  console.log('detail-unit: passed');
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
