import assert from 'node:assert/strict';
import { createOcrProgressState, parseOcrLine } from '../../dist/electron/cliProtocol.js';

const current = createOcrProgressState(3);
const events = [];
const emit = (data) => { events.push(data); };

parseOcrLine('OCR failed a.pdf: invalid_input:缺少 file 字段', current, emit);
parseOcrLine('OCR failed a.pdf: invalid_input:缺少 file 字段', current, emit);
parseOcrLine('OCR failed b.pdf: efapiao_timeout', current, emit);
parseOcrLine('OCR complete: scanned=3, parsed=0, skipped=0, failed=3, updated=3', current, emit);

const done = events.at(-1);
assert.equal(done.done, true);
assert.equal(done.failed, 3);
assert.deepEqual(done.failureReasons, [
  { reason: 'invalid_input:缺少 file 字段', count: 2 },
  { reason: 'efapiao_timeout', count: 1 },
]);
assert.equal(
  done.message,
  '有 3 个文件识别失败，主要原因：invalid_input:缺少 file 字段（2 个）。可在「发票库」中仅重试失败项。',
);

console.log('OCR failure-reasons unit tests passed');
