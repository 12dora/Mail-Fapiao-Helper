import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../dist/config.js';
import { summarizeInbox, summarizeLibrary, loadAppSummary } from '../../dist/electron/summary.js';
import { createSummaryFacade } from '../../dist/electron/summaryFacade.js';
import { mailHashForRow } from '../../dist/electron/mailStatus.js';
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
  const hashes = Object.fromEntries(names.map((name, i) => [name, String(i + 1).repeat(32)]));
  const index = names.map((name, i) => ({
    mailHash: name === 'legacy' ? '' : hashes[name], messageId: name === 'same-id-other' ? '<archived>' : `<${name}>`,
    date: `2026-05-${String(i + 10).padStart(2, '0')}`, from: 'vendor@example.com', subject: name,
    mailbox: 'INBOX', hasAttachment: '1', bodyLinkCount: '0',
  }));
  hashes.legacy = mailHashForRow(index.find(row => row.subject === 'legacy'));
  writeCsv(path.join(dir, cfg.paths.samples, 'INDEX.csv'), index);
  writeCsv(path.join(dir, cfg.paths.pending, 'pending.csv'), [
    { mailHash: hashes.pending, messageId: '<pending>', reason: 'missing_invoice' },
    { mailHash: hashes.archived, messageId: '<archived>', reason: 'missing_invoice' },
  ]);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ processedHashes: ['archived', 'pending', 'ignored'].map(name => hashes[name]), fetchedHashes: Object.values(hashes) }));
  fs.writeFileSync(path.join(dir, cfg.paths.samples, `${hashes.archived}.eml`), 'cached mail');
  fs.writeFileSync(path.join(dir, cfg.paths.pending, `${hashes.pending}.eml`), 'pending mail');
  const ledger = [
    { mailHash: hashes.archived, messageId: '<archived>', filename: 'first.pdf', contentHash: 'content-first', from: 'sender@example.com', subject: 'ledger subject' },
    { mailHash: hashes.archived, messageId: '<archived>', filename: 'second.ofd', contentHash: 'content-second' },
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
  assert.deepEqual(names.map((name) => { const row = inboxByHash.get(hashes[name]); return [row.status, row.documentCount, row.mailOpenable]; }), [
    ['archived', 2, true], ['pending', 0, true], ['ignored', 0, false],
    ['unprocessed', 0, false], ['archived', 1, false], ['unprocessed', 0, false],
  ]);
  assert.match(inboxByHash.get(hashes.legacy).mailHash, /^[a-f0-9]{12,32}$/);
  assert.equal(summarizeInbox(cfg, dir).limit, 500);
  assert.equal(summarizeInbox(cfg, dir, { limit: 100001 }).limit, 100000);
  assert.deepEqual(summarizeInbox(cfg, dir, { offset: 2, limit: 1 }).rows, inbox.rows.slice(2, 3));

  const library = summarizeLibrary(cfg, dir, { limit: 100000 });
  assert.deepEqual(library.duplicates, { groups: 2, rows: 5 });
  const byFilename = new Map(library.rows.map((row) => [row.filename, row]));
  for (const filename of ['first.pdf', 'second.ofd', 'partial.pdf']) {
    assert.equal(byFilename.get(filename).duplicateGroup, invoiceNo);
    assert.equal(byFilename.get(filename).duplicateCount, 3);
  }
  for (const filename of ['queued.pdf', 'bare.pdf']) {
    assert.equal(byFilename.get(filename).duplicateGroup, '');
    assert.equal(byFilename.get(filename).duplicateCount, 0);
  }
  for (const filename of ['short.pdf', 'short2.pdf']) {
    assert.equal(byFilename.get(filename).duplicateGroup, '1234');
    assert.equal(byFilename.get(filename).duplicateCount, 2);
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
  assert.equal(page.rows[0].duplicateCount, 3);
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
    isPathSegmentInside: inside, isInsideOpenPathAllowedRoots: (value) => value.startsWith(external),
  });
  const raw = loadAppSummary(configPath, dir, configPath);
  raw.library.rows[0].filePath = external;
  raw.library.rows[0].fileHandle = external;
  const externalRow = externalFacade.sanitizeAppSummary(raw).library.rows[0];
  assert.match(externalRow.fileHandle, /^ext:/);
  assert.equal(externalRow.fileHandle, externalRow.filePath);
  assert.equal(externalFacade.resolveExternalFileHandle(externalRow.fileHandle), external);
  assert.equal(externalFacade.issueOpenableHandle(external), externalRow.fileHandle);
  // A complete advertised-size response keeps every handle usable, including its first row.
  const handles = Array.from({ length: 100000 }, (_, i) => externalFacade.issueOpenableHandle(`${external}-${i}`));
  for (let i = 0; i < handles.length; i++) {
    assert.equal(externalFacade.resolveExternalFileHandle(handles[i]), `${external}-${i}`);
  }
  // Crossing the bound evicts oldest entries from both maps; reissuing cannot return a dead handle.
  for (let i = 100000; i < 200001; i++) externalFacade.issueOpenableHandle(`${external}-${i}`);
  assert.equal(externalFacade.resolveExternalFileHandle(handles[0]), undefined);
  const renewed = externalFacade.issueOpenableHandle(`${external}-0`);
  assert.notEqual(renewed, handles[0]);
  assert.equal(externalFacade.resolveExternalFileHandle(renewed), `${external}-0`);
  const legacyIndex = { messageId: '<legacy>', from: 'old@example.com', subject: 'old' };
  writeCsv(path.join(dir, cfg.paths.samples, 'INDEX.csv'), [legacyIndex]);
  const legacyInbox = summarizeInbox(cfg, dir).rows[0];
  assert.equal(legacyInbox.mailHash, mailHashForRow(legacyIndex));
  assert.equal(legacyInbox.status, 'archived');
  assert.equal(legacyInbox.documentCount, 1);
});
console.log('summary-unit: passed');
