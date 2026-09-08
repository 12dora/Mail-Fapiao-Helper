import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selectPendingReplayPaths } from '../../dist/cli/pendingReplay.js';
import { stageDocuments } from '../../dist/download/downloader.js';
import { readArchivedIndex } from '../../dist/pipeline/ledger.js';
import { contentHash } from '../../dist/util/hash.js';
import { withTempDir } from './_shared.mjs';

const silent = { info() {}, warn() {}, debug() {}, error() {} };

// 1. 「全部重试」只重放 pending.csv 里仍待确认的邮件，历史副本不再反复重跑。
await withTempDir('mfh-replay-select-', async (dir) => {
  const csv = path.join(dir, 'pending.csv');
  fs.writeFileSync(csv, '\uFEFFmailHash,messageId,date,from,subject,reason\nAAA111,<a>,d,f,s,r\nccc333,<c>,d,f,s,r\n');
  const emls = ['aaa111', 'bbb222', 'ddd444'].map((h) => path.join(dir, `${h}.eml`));
  const picked = selectPendingReplayPaths(emls, csv);
  assert.deepEqual(picked.paths, [emls[0]]);
  assert.equal(picked.stale, 2);
  assert.equal(picked.missing, 1);
  const none = selectPendingReplayPaths(emls, path.join(dir, 'absent.csv'));
  assert.deepEqual(none.paths, []);
  assert.equal(none.stale, 3);
});

// 2. 同一 http 来源重新下载、字节变了：复用既有归档，不再多归档一份；附件来源不受影响。
await withTempDir('mfh-replay-reuse-', async (dir) => {
  const invoices = path.join(dir, 'invoices');
  fs.mkdirSync(invoices, { recursive: true });
  const first = Buffer.from('%PDF-1.4 first');
  fs.writeFileSync(path.join(invoices, '0001.pdf'), first);
  const attach = Buffer.from('%PDF-1.4 attach');
  fs.writeFileSync(path.join(invoices, '0002.pdf'), attach);
  const url = 'https://dppt.shanghai.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&Fphm=1';
  const ledger = path.join(dir, 'invoices.csv');
  fs.writeFileSync(ledger, [
    '\uFEFFmessageId,date,from,subject,filename,source,contentHash,mailHash',
    `<m1>,d,f,s,0001.pdf,${url},${contentHash(first)},h1`,
    `<m1>,d,f,s,0002.pdf,发票.pdf,${contentHash(attach)},h1`,
    `<other>,d,f,s,0003.pdf,${url},deadbeef0000,h2`,
  ].join('\n') + '\n');

  const index = readArchivedIndex(ledger, '<m1>', invoices);
  assert.deepEqual([...index.bySource.keys()], [url], '只索引 http(s) 来源');
  assert.equal(index.bySource.get(url).filename, '0001.pdf');

  const regenerated = Buffer.from('%PDF-1.4 second-generation');
  const changedAttachment = Buffer.from('%PDF-1.4 attach-v2');
  const batch = stageDocuments([
    { data: regenerated, source: url, format: 'pdf' },
    { data: changedAttachment, source: '发票.pdf', format: 'pdf' },
  ], 'h1', invoices, silent, {
    alreadyArchived: index.byContentHash,
    alreadyArchivedBySource: index.bySource,
  });
  assert.equal(batch.pending, 1, '只有附件那份需要新建文件');
  batch.plan();
  const results = batch.commit();
  const byIndex = new Map(results.map((r) => [r.sourceIndex, r]));
  assert.equal(byIndex.get(0).reused, true);
  assert.equal(byIndex.get(0).filename, '0001.pdf');
  assert.equal(byIndex.get(0).contentHash, contentHash(first), '复用条目沿用台账里的 contentHash');
  assert.equal(byIndex.get(1).reused, false);
  assert.equal(fs.readFileSync(path.join(invoices, '0001.pdf')).toString(), first.toString(), '既有文件不被覆盖');
  batch.dispose();
});

console.log('replay-idempotency-unit: passed');
