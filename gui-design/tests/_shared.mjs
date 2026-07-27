/* Shared test infrastructure (CODE-01 / CODE-03).
 *
 * Every suite in this folder builds on the helpers below so that:
 *   - a stale or missing `dist/` fails loudly instead of silently testing
 *     yesterday's compiler output,
 *   - every acquired resource (HTTP server, browser, Electron app, temp dir) is
 *     released by a nested cleanup stack even when a *later* acquisition throws,
 *   - a hung launch or a wedged child process ends the suite with a clear
 *     timeout error instead of pinning a CI runner forever.
 *
 * None of these helpers weaken an assertion; they only make failures honest.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function fail(message) {
  throw new Error(message);
}

/* ---------------------------------------------------------------------------
 * Build freshness (CODE-02)
 *
 * The suites execute `dist/index.js` and `dist/electron/main.js`. `dist/` is
 * git-ignored, so it can be absent, or older than the sources it claims to
 * compile. Either way the run would "pass" against code nobody is shipping.
 * ------------------------------------------------------------------------ */

const BUILD_INPUT_DIRS = ['src'];
const BUILD_INPUT_FILES = ['tsconfig.json'];
const BUILD_OUTPUT_DIR = 'dist';

async function newestMtimeMs(absPath, { extensions } = {}) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(absPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(absPath, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtimeMs(child, { extensions }));
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
    try {
      newest = Math.max(newest, statSync(child).mtimeMs);
    } catch {
      // Racing rebuild; ignore this file.
    }
  }
  return newest;
}

/**
 * @returns {Promise<string[]>} human-readable problems; empty means the build
 * output exists and is at least as new as every TypeScript source.
 */
export async function buildFreshnessProblems() {
  const problems = [];
  for (const relative of ['dist/index.js', 'dist/electron/main.js']) {
    if (!existsSync(join(repoRoot, relative))) {
      problems.push(`missing ${relative} — run \`npm run build\` (the suites execute the compiled output, not the TypeScript sources)`);
    }
  }
  if (problems.length > 0) return problems;

  let newestSource = 0;
  for (const dir of BUILD_INPUT_DIRS) {
    newestSource = Math.max(newestSource, await newestMtimeMs(join(repoRoot, dir), { extensions: ['.ts', '.tsx', '.json'] }));
  }
  for (const file of BUILD_INPUT_FILES) {
    try {
      newestSource = Math.max(newestSource, statSync(join(repoRoot, file)).mtimeMs);
    } catch {
      // Optional input.
    }
  }
  const newestOutput = await newestMtimeMs(join(repoRoot, BUILD_OUTPUT_DIR), { extensions: ['.js'] });
  if (newestSource > newestOutput) {
    const age = Math.round((newestSource - newestOutput) / 1000);
    problems.push(
      `${BUILD_OUTPUT_DIR}/ is ${age}s older than the newest TypeScript source — run \`npm run build\` before the tests (a stale dist means the suite is asserting against code that is no longer in src/)`,
    );
  }
  return problems;
}

/** Hard-fails the current suite when `dist/` is missing or stale. */
export async function assertFreshBuild() {
  const problems = await buildFreshnessProblems();
  if (problems.length === 0) return;
  fail(`构建产物不是最新的，测试拒绝运行：\n  - ${problems.join('\n  - ')}`);
}

/* ---------------------------------------------------------------------------
 * Nested resource cleanup (CODE-03)
 * ------------------------------------------------------------------------ */

const CLEANUP_STEP_TIMEOUT_MS = 20000;

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Runs `body` with a cleanup stack. Resources are registered as they are
 * acquired, and released in reverse order — so a browser launch that throws
 * still closes the HTTP server that was started before it.
 */
export async function withCleanup(body) {
  const stack = [];
  const scope = {
    /** @param {string} label @param {() => unknown} release */
    defer(label, release, { releaseTimeoutMs = CLEANUP_STEP_TIMEOUT_MS } = {}) {
      stack.push({ label, release, releaseTimeoutMs });
    },
    /**
     * Acquire a resource and register its release in one step.
     * `releaseTimeoutMs` covers slow-but-legitimate teardown (Playwright's own
     * graceful browser close can take ~30s before it SIGKILLs).
     */
    async use(label, acquire, release, { timeoutMs = 60000, releaseTimeoutMs = CLEANUP_STEP_TIMEOUT_MS } = {}) {
      const resource = await withDeadline(acquire(), timeoutMs, `获取资源「${label}」`);
      stack.push({ label, releaseTimeoutMs, release: () => release(resource) });
      return resource;
    },
  };
  try {
    return await body(scope);
  } finally {
    const errors = [];
    while (stack.length > 0) {
      const { label, release, releaseTimeoutMs } = stack.pop();
      try {
        await withDeadline(release(), releaseTimeoutMs ?? CLEANUP_STEP_TIMEOUT_MS, `清理「${label}」`);
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errors.length > 0) {
      console.error(`[cleanup] 以下资源没有干净释放：\n  - ${errors.join('\n  - ')}`);
    }
  }
}

/** Temp directory that is always removed, even if the suite throws. */
export async function useTempDir(scope, prefix) {
  return scope.use(
    `临时目录 ${prefix}`,
    () => mkdtemp(join(tmpdir(), prefix)),
    (dir) => rm(dir, { recursive: true, force: true }),
    { timeoutMs: 15000 },
  );
}

/* ---------------------------------------------------------------------------
 * Process-tree termination (CODE-03)
 * ------------------------------------------------------------------------ */

function childPids(pid) {
  if (process.platform === 'win32') return [];
  // `pgrep -P` exists on both macOS and Linux; fall back to a full `ps` scan.
  const pgrep = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (pgrep.status === 0) {
    return pgrep.stdout.split('\n').map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (pgrep.status === 1) return []; // pgrep: no matches.
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  return String(ps.stdout || '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([child, parent]) => parent === pid && Number.isInteger(child) && child > 0)
    .map(([child]) => child);
}

/**
 * Kills `pid` and every descendant. Electron spawns the CLI, which can spawn the
 * OCR engine; `app.close()` only reaches the top process, so an aborted suite
 * used to leak `efapiao serve` style children (APP-16 territory).
 */
export function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  for (const child of childPids(pid)) killProcessTree(child);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Releases a Playwright-launched Electron app.
 *
 * `app.close()` can wedge (a blocked before-quit handler, a child that ignores
 * SIGTERM). Waiting on it inside the cleanup deadline would abandon the kill
 * step entirely, so the graceful close gets its own budget and the process tree
 * is terminated unconditionally afterwards.
 */
export async function closeElectronApp(app, { graceMs = 10000 } = {}) {
  const pid = app?.process?.()?.pid;
  try {
    await Promise.race([
      Promise.resolve(app.close()).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
  } finally {
    killProcessTree(pid);
  }
}

/* ---------------------------------------------------------------------------
 * Suite runner with an overall timeout
 * ------------------------------------------------------------------------ */

const DEFAULT_SUITE_TIMEOUT_MS = 5 * 60 * 1000;

export async function runSuite(name, main, { timeoutMs = DEFAULT_SUITE_TIMEOUT_MS } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${name} 超过 suite 超时上限（${Math.round(timeoutMs / 1000)}s），判定为失败`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([main(), timeout]);
    console.log(`${name} passed`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
  // If a launch hung, cleanup for the abandoned body is still unwinding in the
  // background. Give it a short grace period, then leave rather than hang CI.
  setTimeout(() => process.exit(process.exitCode ?? 0), 8000).unref();
}
