import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDedupeReport, registerOperationHandlers } from '../../dist/electron/ipc/operationHandlers.js';

const report = {
  mode: 'invoice-no', applied: false, quarantineDir: null,
  pairs: 1, redundant: 1, quarantined: 0, ledgerRowsRemoved: 0, ocrRowsRemoved: 0,
  groups: [{ invoiceNo: '12345678901234567890', kept: { filename: 'a.pdf', date: '', seller: '商户 {甲}', amount: '1', format: 'pdf' }, removed: [], conflict: false, conflictReason: '' }],
  conflicts: 0, skipped: [], recovered: 0,
};
assert.deepEqual(parseDedupeReport(`log {invalid}\n${JSON.stringify({ ...report, redundant: 8 })}\nlog\n${JSON.stringify(report, null, 2)}\nfinished`), report);
assert.equal(parseDedupeReport('only logs'), null);
assert.equal(parseDedupeReport(JSON.stringify({ ...report, pairs: -1 })), null);
assert.equal(parseDedupeReport(JSON.stringify({ ...report, recovered: -1 })), null);
assert.equal(parseDedupeReport(`${JSON.stringify(report)}\n{"error":"failed"}`), null);

let released = 0;
let busy = false;
let result = { code: 0, started: true, stdout: JSON.stringify(report), stderr: '' };
let reportOnDisk;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfh-dedupe-ipc-'));
const reportFile = path.join(dataDir, '.mfh-cache', 'dedupe-report.json');
try {
  const calls = [];
  const history = [];
  const handlers = new Map();
  registerOperationHandlers({
    handleTrusted: (channel, handler) => handlers.set(channel, handler),
    processRegistries: { ocrProcesses: new Map(), ocrStopRequested: new Set() },
    configPath: '/fixture/config.json',
    dataDir,
    acquireOperation: (kind) => {
      assert.equal(kind, 'pipeline');
      return busy ? { ok: false, response: { ok: false, code: 'operation_busy', message: '已有任务正在运行。' } }
        : { ok: true, lease: { jobId: 'fixture-job', release: () => released++ } };
    },
    ensureArchiveRecoveryReady: () => undefined,
    runCli: async (...args) => {
      assert.equal(fs.existsSync(reportFile), false, 'previous report must be removed before starting the CLI');
      calls.push(args);
      if (reportOnDisk !== undefined) {
        fs.mkdirSync(path.dirname(reportFile), { recursive: true });
        fs.writeFileSync(reportFile, reportOnDisk);
      }
      return result;
    },
    recordHistory: (...args) => { history.push(args); },
    reportFor: (_action, _job, _result, codes, status) => ({ code: status === 'success' ? codes.ok : status === 'partial' ? codes.partial : codes.failed }),
    tryAppSummary: () => ({}),
  });
  const invoke = (payload) => handlers.get('mfh:dedupe')(null, payload);
  for (const payload of [{}, { by: 'invalid', apply: false }, { by: 'container', apply: 'false' }]) {
    assert.equal((await invoke(payload)).code, 'invalid_dedupe_options');
  }
  assert.equal(calls.length, 0);
  busy = true;
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report));
  assert.equal((await invoke({ by: 'invoice-no', apply: true })).code, 'operation_busy');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(reportFile), true, 'busy requests must not clear the active operation report');
  busy = false;
  let response = await invoke({ by: 'invoice-no', apply: false });
  assert.equal(response.status, 'success');
  assert.equal(response.code, 'dedupe_done');
  assert.deepEqual(response.report, report);
  assert.deepEqual(calls[0], ['dedupe', ['--config', '/fixture/config.json', '--by', 'invoice-no', '--json'], { jobId: 'fixture-job' }]);
  assert.equal(history[0][0], 'dedupe');
  assert.equal(history[0][1], '清理重复发票');
  assert.equal(released, 1);
  result = { ...result, stdout: JSON.stringify({ ...report, applied: true, conflicts: 1 }) };
  response = await invoke({ by: 'container', apply: true });
  assert.equal(response.code, 'dedupe_partial');
  assert.deepEqual(calls[1][1], ['--config', '/fixture/config.json', '--by', 'container', '--apply', '--json']);
  result = { ...result, stdout: 'not a report' };
  assert.equal((await invoke({ by: 'container', apply: false })).code, 'dedupe_failed');
  assert.equal(released, 3);

  // The report file survives stdout truncation and takes precedence over a valid stdout report.
  const fullReport = {
    ...report,
    quarantineDir: path.join(dataDir, 'invoices', '.dedupe-quarantine', '2026-09-05'),
    groups: Array.from({ length: 4000 }, () => report.groups[0]),
    recovered: 2,
    skipped: [{ filename: 'locked.pdf', reason: `EACCES: rename '${path.join(dataDir, 'invoices', 'locked.pdf')}'` }],
  };
  reportOnDisk = JSON.stringify(fullReport);
  assert.ok(Buffer.byteLength(reportOnDisk) > 512 * 1024);
  result = { ...result, stdout: reportOnDisk.slice(-512 * 1024) };
  response = await invoke({ by: 'invoice-no', apply: false });
  assert.equal(response.report.groups.length, 4000);
  assert.equal(response.report.recovered, 2);
  assert.equal(response.report.quarantineDir, 'invoices/.dedupe-quarantine/2026-09-05');
  assert.equal(response.report.skipped[0].reason.includes(dataDir), false);
  assert.match(response.report.skipped[0].reason, /EACCES.*locked\.pdf/);

  result = { ...result, stdout: JSON.stringify(report) };
  response = await invoke({ by: 'invoice-no', apply: false });
  assert.equal(response.report.groups.length, 4000, 'file takes precedence over valid stdout');
  reportOnDisk = JSON.stringify({ ...report, quarantineDir: path.join(dataDir, '..', 'outside') });
  response = await invoke({ by: 'container', apply: false });
  assert.equal(response.report.quarantineDir, '');

  // Invalid/missing files fall back to stdout; stale valid files cannot turn a failed run into success.
  reportOnDisk = '{invalid JSON';
  response = await invoke({ by: 'container', apply: false });
  assert.deepEqual(response.report, report);
  reportOnDisk = JSON.stringify({ incomplete: true });
  response = await invoke({ by: 'container', apply: false });
  assert.deepEqual(response.report, report);
  fs.writeFileSync(reportFile, JSON.stringify(report));
  reportOnDisk = undefined;
  result = { ...result, code: 1, stdout: '' };
  response = await invoke({ by: 'invoice-no', apply: true });
  assert.equal(response.code, 'dedupe_failed');
  assert.equal(response.report, null);
  assert.equal(released, calls.length, 'every operation releases its lease');
  console.log('dedupe IPC unit tests passed');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
