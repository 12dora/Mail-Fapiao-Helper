// mfh:open-external / mfh:pick-directory / mfh:export-csv 的单元覆盖。
// 对话框与 shell 由注入的桩代替，所以不需要真的起一个 Electron 窗口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerShellHandlers } from '../../dist/electron/ipc/shellHandlers.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mfh-shell-'));
try {
  const opened = [];
  let openFails = false;
  let openDialog = { canceled: true, filePaths: [] };
  let saveDialog = { canceled: true, filePath: '' };
  let trusted = true;
  const handlers = new Map();

  registerShellHandlers({
    handleTrusted: (channel, handler) => handlers.set(channel, handler),
    getMainWindow: () => undefined,
    assertTrustedSender: () => trusted,
    dialog: {
      showOpenDialog: async () => openDialog,
      showSaveDialog: async () => saveDialog,
    },
    shell: {
      openExternal: async (url) => {
        if (openFails) throw new Error('no browser');
        opened.push(url);
      },
    },
  });

  const call = (channel, payload) => handlers.get(channel)({}, payload);

  // --- open-external: 名单之外一律拒绝 -------------------------------------
  const repo = 'https://github.com/12dora/Mail-Fapiao-Helper';
  assert.equal((await call('mfh:open-external', { url: repo })).ok, true);
  assert.equal((await call('mfh:open-external', { url: `${repo}/issues` })).ok, true);
  // 末尾斜杠是同一个地址。
  assert.equal((await call('mfh:open-external', { url: `${repo}/` })).ok, true);
  assert.deepEqual(opened, [repo, `${repo}/issues`, repo]);
  for (const bad of [
    `${repo}.evil.com`,
    `${repo}/../../other`,
    'https://github.com/12dora/Mail-Fapiao-Helper/releases',
    'http://github.com/12dora/Mail-Fapiao-Helper',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '',
    undefined,
  ]) {
    const result = await call('mfh:open-external', { url: bad });
    assert.equal(result.ok, false, `must reject ${String(bad)}`);
    assert.equal(result.code, 'external_url_not_allowed');
  }
  assert.equal(opened.length, 3, 'rejected urls must never reach the shell');

  openFails = true;
  const failed = await call('mfh:open-external', { url: repo });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'external_open_failed');
  openFails = false;

  // --- pick-directory: 原始绝对路径原样返回 --------------------------------
  assert.equal((await call('mfh:pick-directory', {})).canceled, true);
  const picked = path.join(cwd, '发票 目录');
  openDialog = { canceled: false, filePaths: [picked] };
  const dir = await call('mfh:pick-directory', { title: '选择发票目录' });
  assert.equal(dir.ok, true);
  assert.equal(dir.path, picked, 'the renderer sends this straight back through saveConfig');
  trusted = false;
  assert.equal((await call('mfh:pick-directory', {})).code, 'untrusted_sender');
  trusted = true;

  // --- export-csv ----------------------------------------------------------
  assert.equal((await call('mfh:export-csv', { filename: 'a.csv', csv: '' })).code, 'export_empty');
  const tooBig = 'x'.repeat(20 * 1024 * 1024 + 1);
  assert.equal((await call('mfh:export-csv', { filename: 'a.csv', csv: tooBig })).code, 'export_too_large');
  // 上限按补过 BOM 之后的字节数算：正好卡在上限的内容加上 BOM 就超了。
  assert.equal(
    (await call('mfh:export-csv', { filename: 'a.csv', csv: 'x'.repeat(20 * 1024 * 1024) })).code,
    'export_too_large',
  );
  assert.equal((await call('mfh:export-csv', { filename: 'a.csv', csv: 'a,b' })).canceled, true);

  const target = path.join(cwd, 'out.csv');
  saveDialog = { canceled: false, filePath: target };
  const saved = await call('mfh:export-csv', { filename: '发票清单.csv', csv: '日期,金额\r\n2026-09-05,12.00' });
  assert.equal(saved.ok, true);
  // 落盘的文件必须带 UTF-8 BOM，Excel 直接双击打开才不会把中文认成乱码。
  const bytes = fs.readFileSync(target);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'exported CSV must start with a UTF-8 BOM');
  assert.equal(bytes.toString('utf8'), '\uFEFF日期,金额\r\n2026-09-05,12.00');
  // 已经带 BOM 的内容不会被加第二个。
  const twice = path.join(cwd, 'twice.csv');
  saveDialog = { canceled: false, filePath: twice };
  await call('mfh:export-csv', { filename: 'a.csv', csv: '\uFEFF日期\r\n1' });
  assert.equal(fs.readFileSync(twice, 'utf8'), '\uFEFF日期\r\n1');
  saveDialog = { canceled: false, filePath: target };
  assert.ok(!saved.path.includes(cwd), 'the returned path is redacted for display only');
  // 原子写不留临时文件。
  assert.deepEqual(fs.readdirSync(cwd).filter((name) => name.includes('.tmp-')), []);

  saveDialog = { canceled: false, filePath: path.join(cwd, 'missing-dir', 'out.csv') };
  assert.equal((await call('mfh:export-csv', { filename: 'a.csv', csv: 'a' })).code, 'export_write_failed');

  saveDialog = { canceled: false, filePath: target };
  trusted = false;
  assert.equal((await call('mfh:export-csv', { filename: 'a.csv', csv: 'b' })).code, 'untrusted_sender');
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    '\uFEFF日期,金额\r\n2026-09-05,12.00',
    'untrusted callers must not write',
  );
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
console.log('shell-ipc-unit: passed');
