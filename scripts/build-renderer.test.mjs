import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'gui-design', 'dist');

function buildRenderer(...args) {
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-renderer.mjs'), ...args], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
}

/*
 * `--production` only stops *generating* sourcemaps. Before it also wiped the
 * output directory, an app.js.map left behind by `npm run dev:renderer` sat
 * there through every later production build and got packaged by
 * electron-builder's `gui-design/**​/*` glob.
 */
test('a production build wipes what an earlier dev build left behind', () => {
  mkdirSync(outDir, { recursive: true });
  const stale = path.join(outDir, 'app.js.map');
  const strayDir = path.join(outDir, 'chunks');
  writeFileSync(stale, '{"version":3,"sources":["../src/main.tsx"]}');
  mkdirSync(strayDir, { recursive: true });
  writeFileSync(path.join(strayDir, 'old.js'), '// from an earlier build\n');

  buildRenderer('--production');

  assert.ok(!existsSync(stale), 'a stale sourcemap must not survive a production build');
  assert.ok(!existsSync(strayDir), 'stale output directories must not survive either');
  assert.deepEqual(readdirSync(outDir).sort(), ['app.css', 'app.js']);
});

test('a development build keeps its sourcemap', () => {
  rmSync(outDir, { recursive: true, force: true });
  buildRenderer();
  assert.ok(existsSync(path.join(outDir, 'app.js.map')), 'dev builds are debuggable');

  // Leave the tree the way every other suite expects to find it.
  buildRenderer('--production');
  assert.deepEqual(readdirSync(outDir).sort(), ['app.css', 'app.js']);
});
