import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeSource, collectReport } from './code-smells.mjs';

const filler = Array.from({ length: 81 }, () => '  work();').join('\n');

test('finds factories with object return types without counting their contracts as bodies', () => {
  const source = `export function createService(deps: Deps): {
  run: () => { ok: boolean };
} {
${filler}
  return { run: () => ({ ok: true }) };
}
class Neighbor {
  short() { return true; }
}`;
  const report = analyzeSource(source, 'factory.ts');
  assert.deepEqual(report.functions.map(fn => [fn.name, fn.startLine, fn.endLine]), [
    ['createService', 1, 86], ['run', 85, 85], ['short', 88, 88],
  ]);
});

test('tracks async block arrows, methods and nested declarations through strings/comments/regex', () => {
  const source = `const handler = async (input: string): Promise<void> => {
  const text = "} function decoy() {";
  const template = \`} ignored {\`;
  const regex = /[{}]\\/\"/;
  /* } function fake() { */
  // } function fake() {
  function nested() { return input; }
${filler}
};
const object = {
  async method<T>(input: T): Promise<T> {
${filler}
    return input;
  },
};`;
  const report = analyzeSource(source, 'arrows.tsx');
  assert.deepEqual(report.functions.map(fn => fn.name), ['handler', 'nested', 'method']);
  assert.equal(report.functions[0].lines, 89);
  assert.equal(report.functions[1].lines, 1);
  assert.equal(report.functions[2].lines, 84);
});

test('counts named/type exports and ignores quoted or commented export text', () => {
  const source = `export { alpha, beta as renamed, };
export type { First, Second };
export interface Model { value: string }
export const fn = () => true;
const text = 'export fake';
// export fake
export * from './other.js';`;
  assert.equal(analyzeSource(source, 'exports.ts').exports, 7);
});

test('reports both roots, descending top 15, strict thresholds and normalized JSON data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mfh-smells-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'gui-design', 'src'), { recursive: true });
    for (let index = 0; index < 16; index++) {
      fs.writeFileSync(path.join(root, 'src', `${index}.ts`), '\n'.repeat(index + 1));
    }
    const renderer = `export const render = async () => {\n${filler}\n};\n`;
    fs.writeFileSync(path.join(root, 'gui-design', 'src', 'view.tsx'), renderer);
    fs.writeFileSync(path.join(root, 'src', 'exports.ts'), Array.from({ length: 26 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
    const report = JSON.parse(JSON.stringify(collectReport(root)));
    assert.equal(report.scannedFiles, 18);
    assert.equal(report.largestFiles.length, 15);
    assert.equal(report.largestFiles[0].file, 'gui-design/src/view.tsx');
    assert.deepEqual(report.longFunctions.map(fn => [fn.name, fn.lines]), [['render', 83]]);
    assert.deepEqual(report.exportHeavyFiles, [{ file: 'src/exports.ts', lines: 26, exports: 26 }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tracks parenthesized TSX expression arrows and nested callback arrows', () => {
  const jsx = Array.from({ length: 81 }, (_, index) => `  <span>{${index}}</span>`).join('\n');
  const source = `export const View = (props: Props) => (
  <section>
${jsx}
    {props.items.map(item => (
      <span>{item.label}</span>
    ))}
  </section>
);
export const make = async (): Promise<Result> => (
  { value: 1 }
);`;
  const report = analyzeSource(source, 'view.tsx');
  assert.deepEqual(report.functions.map(fn => [fn.name, fn.startLine, fn.endLine]), [
    ['View', 1, 88], ['<anonymous>', 84, 86], ['make', 89, 91],
  ]);
});

test('counts multiple exported declarators without counting initializer or generic commas', () => {
  const source = `export const first = { a: 1, b: 2 }, second = call(1, 2), third: Map<Key, Value> = new Map();
export let left, right;
export const callback = function named(a, b) { return [a, b]; }, last = true;
export const generic = call<First, Second, Third>(), final = 1;`;
  assert.equal(analyzeSource(source, 'exports.ts').exports, 9);
  const threshold = `export const ${Array.from({ length: 26 }, (_, index) => `value${index} = ${index}`).join(', ')};`;
  assert.equal(analyzeSource(threshold, 'threshold.ts').exports, 26);
});
