import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../dist/config.js';
import { summarizeInbox, summarizeLibrary, loadAppSummary } from '../../dist/electron/summary.js';
import { createSummaryFacade } from '../../dist/electron/summaryFacade.js';
import { repoRoot, withTempDir } from './_shared.mjs';

function writeCsv(file, rows) {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${columns.join(',')}\n${rows.map((row) => columns.map((key) => cell(row[key])).join(',')).join('\n')}\n`);
}

await withTempDir('mfh-summary-unit-', async (dir) => {
  const configPath = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(repoRoot, 'config.example.json'), configPath);
  const cfg = loadConfig(configPath);
  const names = ['archived', 'pending', 'ignored', 'unprocessed', 'legacy', 'same-id-other'];
  const index = names.map((name, i) => ({
    mailHash: name, messageId: name === 'same-id-other' ? '<archived>' : `<${name}>`,
    date: `2026-05-${String(i + 10).padStart(2, '0')}`, from: 'vendor@example.com', subject: name,
    mailbox: 'INBOX', hasAttachment: '1', bodyLinkCount: '0',
  }));
  writeCsv(path.join(dir, cfg.paths.samples, 'INDEX.csv'), index);
  writeCsv(path.join(dir, cfg.paths.pending, 'pending.csv'), [
    { mailHash: 'pending', messageId: '<pending>', reason: 'missing_invoice' },
    { mailHash: 'archived', messageId: '<archived>', reason: 'missing_invoice' },
  ]);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ processedHashes: ['archived', 'pending', 'ignored'], fetchedHashes: names }));
  fs.writeFileSync(path.join(dir, cfg.paths.samples, 'archived.eml'), 'cached mail');
  fs.writeFileSync(path.join(dir, cfg.paths.pending, 'pending.eml'), 'pending mail');
  const ledger = [
    { mailHash: 'archived', messageId: '<archived>', filename: 'first.pdf', contentHash: 'content-first', from: 'sender@example.com', subject: 'ledger subject' },
    { mailHash: 'archived', messageId: '<archived>', filename: 'second.ofd', contentHash: 'content-second' },
    { mailHash: '', messageId: '<legacy>', filename: 'bare.pdf', contentHash: 'content-bare', from: 'legacy@example.com', subject: 'legacy subject' },
  ];
  writeCsv(path.join(dir, cfg.output.csv), ledger);
  const invoiceNo = '12345678901234567890';
  const result = (filename, contentHash, overrides = {}) => ({
    hash: 'archived', messageId: '<archived>', date: '2026-05-01', filename, contentHash,
    source: filename, invoiceNo, seller: 'Seller', amount: '100.00', status: 'success', ...overrides,
  });
  writeCsv(path.join(dir, cfg.ocr.resultsCsv), [
    result('first.pdf', 'content-first'),
    result('first.pdf', 'content-first', { status: 'error', invoiceNo: '', error: 'later failure' }),
    result('second.ofd', 'content-second', { amount: '200.00' }), // Conflicts still display as duplicates.
    result('partial.pdf', 'content-partial', { status: 'partial' }),
    result('short.pdf', 'content-short', { invoiceNo: '1234' }),
    result('short2.pdf', 'content-short2', { invoiceNo: '1234' }),
  ]);
  writeCsv(path.join(dir, cfg.paths.invoices, 'ocr', 'ocr-pending.csv'), [
    { hash: 'pending', messageId: '<pending>', filename: 'queued.pdf', contentHash: 'content-queued', from: 'queued@example.com', subject: 'queued subject', status: 'pending' },
  ]);
  fs.writeFileSync(path.join(dir, cfg.paths.invoices, 'bare.pdf'), 'archived document');

  const inbox = summarizeInbox(cfg, dir, { limit: 100000 });
  const inboxByHash = new Map(inbox.rows.map((row) => [row.mailHash, row]));
  assert.deepEqual(names.map((hash) => [inboxByHash.get(hash).status, inboxByHash.get(hash).documentCount, inboxByHash.get(hash).mailOpenable]), [
    ['archived', 2, true], ['pending', 0, true], ['ignored', 0, false],
    ['unprocessed', 0, false], ['archived', 1, false], ['unprocessed', 0, false],
  ]);
  assert.equal(summarizeInbox(cfg, dir).limit, 500);
  assert.equal(summarizeInbox(cfg, dir, { limit: 100001 }).limit, 100000);
  assert.deepEqual(summarizeInbox(cfg, dir, { offset: 2, limit: 1 }).rows, inbox.rows.slice(2, 3));

  const library = summarizeLibrary(cfg, dir, { limit: 100000 });
  assert.deepEqual(library.duplicates, { groups: 1, rows: 2 });
  const byFilename = new Map(library.rows.map((row) => [row.filename, row]));
  for (const filename of ['first.pdf', 'second.ofd']) {
    assert.equal(byFilename.get(filename).duplicateGroup, invoiceNo);
    assert.equal(byFilename.get(filename).duplicateCount, 2);
  }
  for (const filename of ['partial.pdf', 'short.pdf', 'short2.pdf', 'queued.pdf', 'bare.pdf']) {
    assert.equal(byFilename.get(filename).duplicateGroup, '');
    assert.equal(byFilename.get(filename).duplicateCount, 0);
  }
  assert.equal(byFilename.get('first.pdf').from, 'sender@example.com');
  assert.equal(byFilename.get('first.pdf').subject, 'ledger subject');
  assert.equal(byFilename.get('bare.pdf').messageId, '<legacy>');
  assert.equal(byFilename.get('bare.pdf').contentHash, 'content-bare');
  assert.equal(byFilename.get('queued.pdf').mailHash, 'pending');
  assert.equal(byFilename.get('queued.pdf').subject, 'queued subject');
  for (const row of library.rows) assert.equal(row.fileHandle, row.filePath);
  const duplicateOffset = library.rows.findIndex((row) => row.filename === 'first.pdf');
  const page = summarizeLibrary(cfg, dir, { limit: 1, offset: duplicateOffset });
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.duplicates, library.duplicates);
  assert.equal(page.rows[0].duplicateCount, 2);
  assert.equal(summarizeLibrary(cfg, dir, { limit: 100001 }).limit, 100000);

  const inside = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
  const facade = createSummaryFacade({
    configPath, dataDir: dir, bundledConfigPath: configPath,
    asObject: (value) => value && typeof value === 'object' ? value : {},
    resolveCanonicalPath: (value) => path.resolve(value), realDataDir: () => dir,
    isPathSegmentInside: inside, isInsideOpenPathAllowedRoots: (value) => inside(value, dir),
  });
  const sanitized = facade.sanitizeAppSummary(loadAppSummary(configPath, dir, configPath));
  for (const row of sanitized.library.rows) {
    assert.equal(row.fileHandle, row.filePath);
    assert.equal(row.fileHandle, `invoices/${row.filename}`);
  }
  const external = path.join(path.dirname(dir), 'external-invoice.pdf');
  const externalFacade = createSummaryFacade({
    configPath, dataDir: dir, bundledConfigPath: configPath,
    asObject: () => ({}), resolveCanonicalPath: (value) => value, realDataDir: () => dir,
    isPathSegmentInside: inside, isInsideOpenPathAllowedRoots: (value) => value === external,
  });
  const raw = loadAppSummary(configPath, dir, configPath);
  raw.library.rows[0].filePath = external;
  raw.library.rows[0].fileHandle = external;
  const externalRow = externalFacade.sanitizeAppSummary(raw).library.rows[0];
  assert.match(externalRow.fileHandle, /^ext:/);
  assert.equal(externalRow.fileHandle, externalRow.filePath);
  assert.equal(externalFacade.resolveExternalFileHandle(externalRow.fileHandle), external);
});
console.log('summary-unit: passed');
