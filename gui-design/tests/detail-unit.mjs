import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMailStatusIndex, mailStatusFor, mailHashForRow } from '../../dist/electron/mailStatus.js';
import { summarizeLibrary } from '../../dist/electron/summary.js';
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
  const mailLink = 'https://user:password@example.com/invoice.pdf?token=short';
  assert.equal(detailLinkUrl(mailLink), mailLink, 'mail.links keeps its explicit full-URL exception');
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
  registerDetailHandlers({ handleTrusted: (name, fn) => handlers.set(name, fn), readConfigForPaths: () => cfg, realDataDir: () => cwd, ledgerCsvPath: () => path.join(cwd, 'invoices.csv'), invoicesDirPath: () => root, appSummary: () => { throw new Error('Details must not build a summary'); }, issueOpenableHandle: target => path.relative(cwd, target), resolveOpenTarget: target => ({ ok: true, path: target }) });
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

  // Legacy results and their later strong retry are one artifact, even when success is older.
  const legacySuccess = { filename: 'legacy.pdf', status: 'success', invoiceNo: 'short-number' };
  const strongRetry = { ...legacySuccess, hash: archived, contentHash: 'legacy-content', status: 'error' };
  assert.deepEqual(currentOcrRows([legacySuccess, strongRetry]), [legacySuccess]);
  assert.equal(currentOcrRows([legacySuccess, strongRetry, {
    ...strongRetry, contentHash: 'other-content',
  }]).length, 2, 'different nonempty hashes must remain separate artifacts');
  const source = `https://user:password@example.com/invoice.pdf?token=${'s'.repeat(65)}&short=keep`;
  fs.writeFileSync(path.join(cwd, 'invoices.csv'), [
    'mailHash,messageId,filename,contentHash,source',
    `${archived},<a>,legacy.pdf,legacy-content,${source}`,
    `${archived},<a>,partial.pdf,partial-content,plain-attachment.pdf`,
  ].join('\n'));
  fs.writeFileSync(path.join(cwd, 'ocr.csv'), [
    'hash,filename,contentHash,status,invoiceNo',
    ',legacy.pdf,,success,short-number',
    `${archived},legacy.pdf,legacy-content,error,short-number`,
    `${archived},partial.pdf,partial-content,partial,short-number`,
  ].join('\n'));
  const legacyDetail = await handlers.get('mfh:invoice-detail')({}, { filename: 'legacy.pdf' });
  assert.equal(legacyDetail.ok, true);
  assert.equal(legacyDetail.invoice.ocr.status, 'success');
  assert.equal(legacyDetail.invoice.row.duplicateCount, 2);
  assert.equal(legacyDetail.invoice.duplicates.length, 1);
  assert.equal(legacyDetail.invoice.duplicates[0].filename, 'partial.pdf');
  assert.equal(legacyDetail.invoice.file.handle, 'invoices/legacy.pdf');
  for (const projected of [legacyDetail.invoice.row.source, legacyDetail.invoice.ledger.source]) {
    const url = new URL(projected);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.searchParams.get('token'), '[已隐藏]');
    assert.equal(url.searchParams.get('short'), 'keep');
  }
  const library = summarizeLibrary(cfg, cwd, { limit: 100000 });
  assert.deepEqual(library.duplicates, { groups: 1, rows: 2 });
  assert.equal(library.rows.find(row => row.filename === 'legacy.pdf').duplicateCount,
    legacyDetail.invoice.row.duplicateCount);
  const archivedDetail = await handlers.get('mfh:mail-detail')({}, { hash: archived });
  assert.equal(archivedDetail.ok, true);
  assert.equal(archivedDetail.mail.documents[0].source, legacyDetail.invoice.row.source);
  assert.equal(archivedDetail.mail.documents[1].source, 'plain-attachment.pdf');
  // Legacy INDEX identity is identical in summary, status, and detail paths.
  const legacyMail = { messageId: '<legacy-mail>', from: 'old@example.com', subject: 'old mail', date: '' };
  const legacyHash = mailHashForRow(legacyMail);
  fs.appendFileSync(path.join(cwd, 'samples/INDEX.csv'), ',<legacy-mail>\n');
  const oldMailDetail = await handlers.get('mfh:mail-detail')({}, { hash: legacyHash });
  assert.equal(oldMailDetail.ok, true);
  assert.equal(oldMailDetail.mail.mailHash, legacyHash);

  console.log('detail-unit: passed');
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
