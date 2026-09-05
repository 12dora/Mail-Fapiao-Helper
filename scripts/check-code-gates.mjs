import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint({
  overrideConfig: [{
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: false } },
    rules: { '@typescript-eslint/await-thenable': 'off' },
  }],
});

async function rulesFor(source, filePath) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.ok(!result.messages.some((message) => message.fatal), JSON.stringify(result.messages));
  return result.messages.map((message) => message.ruleId);
}

function longFunction(name, lines) {
  return `export function ${name}() {\n${"console.log('gate');\n".repeat(lines)}\n}`;
}

const factoryPath = 'src/electron/openPolicy.ts';
assert.deepEqual(await rulesFor(longFunction('createOpenPolicy', 121), factoryPath), []);
assert.ok((await rulesFor(longFunction('neighbor', 121), factoryPath)).includes('baseline/max-lines-per-function'));
assert.ok((await rulesFor(longFunction('createOpenPolicy', 501), factoryPath)).includes('baseline/max-lines-per-function'));
assert.ok((await rulesFor(longFunction('createOpenPolicy', 121), 'src/config.ts')).includes('max-lines-per-function'));
assert.ok((await rulesFor("console.log('gate');\n".repeat(701), 'src/config.ts')).includes('max-lines'));
assert.ok(!(await rulesFor("console.log('gate');\n".repeat(701), 'src/electron/ipc/operationHandlers.ts')).includes('max-lines'));
assert.ok((await rulesFor("console.log('gate');\n".repeat(1101), 'src/electron/ipc/operationHandlers.ts')).includes('max-lines'));
assert.ok(!(await rulesFor(`(() => {\n${"console.log('gate');\n".repeat(121)}})();`, 'src/config.ts')).includes('max-lines-per-function'));
const testRules = await rulesFor('export function sample(a,b,c,d,e,f,g) { return [a,b,c,d,e,f,g]; }', 'gui-design/tests/gate-fixture.mjs');
assert.ok(testRules.includes('max-params'));
const hooks = await rulesFor(`
  import { useEffect } from 'react';
  export function Example({ enabled, value }: { enabled: boolean; value: string }) {
    if (enabled) useEffect(() => { console.log(value); }, []);
    return <div>{value}</div>;
  }
`, 'gui-design/src/gate-fixture.tsx');
assert.ok(hooks.includes('react-hooks/rules-of-hooks'));
assert.ok(hooks.includes('react-hooks/exhaustive-deps'));
assert.ok((await rulesFor('const unusedNeighbor = 1;', 'gui-design/tests/_shared.mjs')).includes('@typescript-eslint/no-unused-vars'));
console.log('Code gate checks passed');
