/* Unit cover for the renderer's CSV writer (gui-design/src/pages/library/csv.ts).
 *
 * The module itself is pure, but it imports the components barrel, which pulls
 * in antd. esbuild bundles it here with that one import stubbed, so the check
 * stays a millisecond-scale string test instead of booting a browser.
 *
 * WHY IT EXISTS: seller names and filenames come out of imported documents. A
 * cell such as `=1+1` written verbatim is executed as a formula the moment the
 * export is opened in Excel / LibreOffice / Google Sheets.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

/* Standalone on purpose: ui-helpers.mjs drags in Playwright, and this suite has
   no browser to drive. */
const uiRoot = fileURLToPath(new URL('..', import.meta.url));

const STUB = `
export const humanizeDocumentType = (row) => row.documentType ?? '';
export const statusLabel = (status) => status ?? '';
`;

/** Replaces the components barrel so the bundle carries no React / antd. */
const stubBarrel = {
  name: 'stub-components-barrel',
  setup(build) {
    build.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'components-barrel', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }));
  },
};

const dir = await mkdtemp(join(tmpdir(), 'mfh-renderer-csv-'));
try {
  const outfile = join(dir, 'csv.mjs');
  await esbuild.build({
    entryPoints: [join(uiRoot, 'src', 'pages', 'library', 'csv.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    plugins: [stubBarrel],
    logLevel: 'silent',
  });
  const { rowsToCsv } = await import(pathToFileURL(outfile).href);

  const row = (over) => ({
    date: '2026-09-05',
    seller: '国家电网有限公司',
    invoiceNo: '12345678901234567890',
    amount: '318.42',
    documentType: 'invoice',
    status: '完整',
    filename: '0001.pdf',
    ...over,
  });

  const header = '日期,销售方,发票号,金额,类型,状态,文件';
  assert.equal(rowsToCsv([]), header, 'an empty export still carries the header row');

  const plain = rowsToCsv([row()]).split('\r\n');
  assert.equal(plain[0], header);
  assert.equal(plain[1], '2026-09-05,国家电网有限公司,12345678901234567890,318.42,invoice,完整,0001.pdf');

  // Every formula lead-in a spreadsheet honours must come back quoted and
  // apostrophe-prefixed, so the cell is imported as text.
  for (const evil of ['=1+1', '+1+1', '-1+cmd|\'/c calc\'!A1', '@SUM(1)', '\tlead', '\rlead', '\nlead']) {
    const line = rowsToCsv([row({ seller: evil })]).split('\r\n')[1];
    const cell = line.split(',')[1];
    assert.ok(cell.startsWith(`"'`), `formula-leading seller must be guarded: ${JSON.stringify(evil)} -> ${cell}`);
    assert.ok(!line.includes(`,${evil}`), `raw formula text leaked: ${line}`);
  }
  const filename = rowsToCsv([row({ filename: '=cmd|calc.pdf' })]).split('\r\n')[1];
  assert.ok(filename.endsWith(`"'=cmd|calc.pdf"`), `filenames are guarded too: ${filename}`);

  // Legitimate negative amounts are numbers, not formulas — leave them alone.
  const negative = rowsToCsv([row({ amount: '-113.00' })]).split('\r\n')[1];
  assert.ok(negative.includes(',-113.00,'), `plain negative amounts must stay untouched: ${negative}`);

  // Ordinary CSV escaping still applies.
  const quoted = rowsToCsv([row({ seller: '滴滴出行, "科技"' })]).split('\r\n')[1];
  assert.ok(quoted.includes('"滴滴出行, ""科技"""'), quoted);

  // Nothing may be prefixed that was not guarded.
  assert.ok(!plain[1].includes("'"), 'benign cells must not grow an apostrophe');

  console.log('renderer-csv-unit: passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
