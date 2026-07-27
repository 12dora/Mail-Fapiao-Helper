#!/usr/bin/env node
// Preflight for the npm test suites (CODE-01).
//
// Every `test:*` script has a matching `pretest:*` hook that runs this file.
// The goal is that a missing runtime prerequisite (no build output, no Electron
// binary, no Playwright Chromium, no display) produces an immediate, explicit
// failure instead of a suite that silently does nothing and reports success.
//
// Usage: node scripts/check-test-prereqs.mjs <cli|electron|browser>

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Single source of truth for "is dist/ usable?", shared with the suites so that
// `node gui-design/tests/<suite>.mjs` fails the same way as `npm run test:*`.
import { buildFreshnessProblems } from '../gui-design/tests/_shared.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const problems = [];

function requireFile(relative, hint) {
  if (!existsSync(path.join(repoRoot, relative))) {
    problems.push(`missing ${relative} — ${hint}`);
  }
}

/**
 * CODE-02: `dist/` is git-ignored, so it can be missing *or* older than the
 * sources it claims to compile. A suite run against a stale dist is a false
 * positive, not a pass, so refuse before a single assertion executes.
 */
async function requireBuildOutput() {
  for (const problem of await buildFreshnessProblems()) problems.push(problem);
}

function requireDisplay(suite) {
  // Electron and Chromium both need a display server on Linux. Without one the
  // launch hangs or dies with an opaque error, so refuse up front.
  if (process.platform !== 'linux') return;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return;
  problems.push(
    `no DISPLAY/WAYLAND_DISPLAY on Linux — ${suite} needs a display server, run it under \`xvfb-run -a npm run test:${suite}\``,
  );
}

async function checkCli() {
  await requireBuildOutput();
}

async function checkElectron() {
  await requireBuildOutput();
  requireFile('config.example.json', 'the Electron suites seed their temp config from this file');

  let electronBinary;
  try {
    electronBinary = require('electron');
  } catch {
    problems.push('cannot resolve the `electron` package — run `npm ci` (electron is a devDependency)');
    return;
  }
  if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
    problems.push(
      'the Electron binary is not installed — run `npm ci` (or `node node_modules/electron/install.js`) so `require("electron")` resolves to an existing executable',
    );
  }
  requirePlaywrightModule('the Electron suites drive the app through playwright\'s `_electron` helper');
  requireDisplay('electron');
}

function requirePlaywrightModule(reason) {
  try {
    require.resolve('playwright');
  } catch {
    problems.push(`cannot resolve the \`playwright\` package — run \`npm ci\` (${reason})`);
    return false;
  }
  return true;
}

async function checkBrowser() {
  if (!requirePlaywrightModule('the browser suites launch Chromium through playwright')) return;
  const { chromium } = await import('playwright');
  let executable;
  try {
    executable = chromium.executablePath();
  } catch (err) {
    problems.push(`playwright cannot report a Chromium executable path: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!executable || !existsSync(executable)) {
    problems.push(
      `Playwright Chromium is not installed at ${executable || '<unknown>'} — run \`npx playwright install chromium\` (on Linux CI use \`npx playwright install --with-deps chromium\`)`,
    );
  }
  requireDisplay('browser');
}

const suites = {
  cli: checkCli,
  electron: checkElectron,
  browser: checkBrowser,
};

const suite = process.argv[2];
if (!suite || !Object.hasOwn(suites, suite)) {
  console.error(`check-test-prereqs: expected one of ${Object.keys(suites).join(', ')}, got ${suite ?? '<nothing>'}`);
  process.exit(2);
}

await suites[suite]();

if (problems.length > 0) {
  console.error(`\ntest:${suite} prerequisites are not satisfied:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nRefusing to run the suite: a skipped suite must never look like a passing suite.\n');
  process.exit(1);
}

console.log(`test:${suite} prerequisites OK`);
