import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot, withTempDir } from './_shared.mjs';

function attachmentMail(id, names) {
  const attachments = names.flatMap((name, index) => [
    '--supporting-boundary',
    `Content-Type: application/pdf; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(`%PDF-1.4\n%${id}-${index}\n%%EOF\n`).toString('base64'),
  ]);
  return [
    'From: service@invoice.example.com',
    'To: me@example.com',
    'Subject: 通行费电子发票',
    'Date: Thu, 21 May 2026 10:00:00 +0800',
    `Message-ID: <${id}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="supporting-boundary"',
    '',
    ...attachments,
    '--supporting-boundary--',
    '',
  ].join('\n');
}

export async function testSupportingArchiveRetention({ writeConfig, runMfh }) {
  const { validateConfigCandidate, migrateRawConfig } = await import(pathToFileURL(join(repoRoot, 'dist/config.js')).href);
  await withTempDir('mfh-cli-supporting-retention-', async (tmp) => {
    const { cfg, path: configPath } = await writeConfig(tmp, { archive: { keepSupporting: false } });
    const previousDataDir = process.env.MFH_DATA_DIR;
    process.env.MFH_DATA_DIR = tmp;
    let configService;
    try {
      configService = await import(pathToFileURL(join(repoRoot, 'dist/electron/configService.js')).href);
    } finally {
      if (previousDataDir === undefined) delete process.env.MFH_DATA_DIR;
      else process.env.MFH_DATA_DIR = previousDataDir;
    }
    const { normalizeSavePayload, redactConfig, mergeDefined } = configService;
    const legacy = { ...cfg };
    delete legacy.archive;
    assert.equal(migrateRawConfig(legacy).raw.archive.keepSupporting, true);
    assert.equal(validateConfigCandidate(legacy).config.archive.keepSupporting, true);
    assert.equal(validateConfigCandidate(cfg).config.archive.keepSupporting, false);
    assert.equal(validateConfigCandidate({ ...cfg, archive: { keepSupporting: 'false' } }).ok, false);
    assert.deepEqual(normalizeSavePayload({ archive: { keepSupporting: false } }).archive, { keepSupporting: false });
    assert.deepEqual(redactConfig(cfg).archive, { keepSupporting: false });
    const { registerConfigHandlers } = await import(pathToFileURL(join(repoRoot, 'dist/electron/ipc/configHandlers.js')).href);
    const handlers = new Map();
    let saved = legacy;
    let released = false;
    registerConfigHandlers({
      handleTrusted: (channel, handler) => handlers.set(channel, handler),
      loadGuiConfig: () => ({ cfg: validateConfigCandidate(saved).config }),
      configPath,
      bundledConfigPath: configPath,
      dataDir: tmp,
      redactConfig,
      coordinator: { begin: () => ({ ok: true, lease: { release: () => { released = true; } } }) },
      saveConfig: (payload) => {
        mergeDefined(saved, normalizeSavePayload(payload));
        saved = migrateRawConfig(saved).raw;
        return { ok: true, config: redactConfig(saved) };
      },
    });
    assert.equal(handlers.get('mfh:get-config')().config.archive.keepSupporting, true);
    assert.equal(handlers.get('mfh:save-config')(null, { archive: { keepSupporting: false } }).config.archive.keepSupporting, false);
    assert.equal(handlers.get('mfh:get-config')().config.archive.keepSupporting, false);
    assert.equal(released, true);

    await mkdir(cfg.paths.samples, { recursive: true });
    await writeFile(join(cfg.paths.samples, 'only.eml'), attachmentMail('supporting-only', ['通行费电子票据汇总单.pdf']));
    await writeFile(join(cfg.paths.samples, 'mixed.eml'), attachmentMail('supporting-mixed', ['订单明细.pdf', '电子发票.pdf']));
    const result = await runMfh(['run', '--config', configPath, '--state', join(tmp, 'state.json'), '--concurrency', '1']).catch((error) => error);
    assert.match(`${result.stdout}\n${result.stderr}`, /supporting_skipped/);
    const { readCsvRows } = await import(pathToFileURL(join(repoRoot, 'dist/util/csv.js')).href);
    const rows = readCsvRows(cfg.output.csv);
    assert.equal(rows.length, 1, 'Only the real invoice enters the archive ledger');
    assert.equal(rows[0].messageId, '<supporting-mixed@example.com>');
    assert.match(rows[0].source, /电子发票\.pdf/);
    const documents = (await readdir(cfg.paths.invoices)).filter((name) => name.endsWith('.pdf'));
    assert.equal(documents.length, 1, 'Supporting attachments must not be installed on disk');
    const pending = await readFile(join(cfg.paths.pending, 'pending.csv'), 'utf8');
    assert.match(pending, /supporting-only@example.com/);
    assert.match(pending, /only_supporting_documents:toll_summary/);
    assert.doesNotMatch(pending, /supporting-mixed@example.com/);
    assert.equal(existsSync(join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv')), true);
    assert.equal(readCsvRows(join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv')).length, 1);
  });
}
