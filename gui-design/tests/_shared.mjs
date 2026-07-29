/* Shared test infrastructure (CODE-01 / CODE-03 / TEST-02 / TEST-03 / TEST-06).
 *
 * Every suite in this folder builds on the helpers below so that:
 *   - a stale or missing `dist/` fails loudly instead of silently testing
 *     yesterday's compiler output,
 *   - every acquired resource (HTTP server, browser, Electron app, temp dir) is
 *     released by a nested cleanup stack even when a *later* acquisition throws,
 *   - acquisition timeouts still dispose late-arriving resources,
 *   - cleanup failures fail the suite instead of printing-and-passing,
 *   - a hung launch or a wedged child process ends the suite with a clear
 *     timeout error instead of pinning a CI runner forever.
 *
 * None of these helpers weaken an assertion; they only make failures honest.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const NO_GUI_E2E_ENV = 'MFH_E2E_NO_GUI';

/**
 * Electron integration tests must launch with MFH_E2E_NO_GUI=1.
 * The main process treats that non-packaged, test-only flag as a no-desktop
 * contract: the BrowserWindow stays hidden and shell.openPath/showItemInFolder
 * IPC handlers return deterministic success without opening Finder or apps.
 */
export function electronTestEnv(extra = {}) {
  return { ...process.env, [NO_GUI_E2E_ENV]: '1', ...extra };
}

export function fail(message) {
  throw new Error(message);
}

/* ---------------------------------------------------------------------------
 * Build freshness (TEST-06)
 *
 * The suites execute specific compiled entrypoints under dist/. Comparing only
 * "newest source mtime" against "newest any .js output" lets a partially stale
 * tree pass (one rebuilt file hides an outdated index.js / archiveJournal.js).
 * Instead: map each .ts under src/ to its .js under dist/ and refuse missing or
 * older outputs, plus the suite entrypoints themselves.
 * ------------------------------------------------------------------------ */

const BUILD_INPUT_DIRS = ['src'];
const BUILD_INPUT_FILES = ['tsconfig.json'];
const BUILD_OUTPUT_DIR = 'dist';
/** Entry points the suites always execute — must exist even if empty of siblings. */
const BUILD_ENTRYPOINTS = ['dist/index.js', 'dist/electron/main.js'];

function listTsSources(absDir, out = []) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = join(absDir, entry.name);
    if (entry.isDirectory()) {
      listTsSources(child, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(child);
    }
  }
  return out;
}

/**
 * @returns {Promise<string[]>} human-readable problems; empty means every
 * compiled output that the tests import exists and is at least as new as its
 * TypeScript source (plus tsconfig).
 */
export async function buildFreshnessProblems() {
  const problems = [];

  for (const relativePath of BUILD_ENTRYPOINTS) {
    if (!existsSync(join(repoRoot, relativePath))) {
      problems.push(
        `missing ${relativePath} — run \`npm run build\` (the suites execute the compiled output, not the TypeScript sources)`,
      );
    }
  }
  if (problems.length > 0) return problems;

  let tsconfigMtime = 0;
  for (const file of BUILD_INPUT_FILES) {
    try {
      tsconfigMtime = Math.max(tsconfigMtime, statSync(join(repoRoot, file)).mtimeMs);
    } catch {
      // Optional input.
    }
  }

  for (const dir of BUILD_INPUT_DIRS) {
    const sources = listTsSources(join(repoRoot, dir));
    for (const srcAbs of sources) {
      const relFromSrc = relative(join(repoRoot, dir), srcAbs);
      const outRel = join(BUILD_OUTPUT_DIR, relFromSrc.replace(/\.ts$/, '.js'));
      const outAbs = join(repoRoot, outRel);
      if (!existsSync(outAbs)) {
        problems.push(
          `missing ${outRel} (compiled from ${join(dir, relFromSrc)}) — run \`npm run build\``,
        );
        continue;
      }
      let srcMtime;
      let outMtime;
      try {
        srcMtime = statSync(srcAbs).mtimeMs;
        outMtime = statSync(outAbs).mtimeMs;
      } catch {
        problems.push(`cannot stat ${outRel} for freshness check — run \`npm run build\``);
        continue;
      }
      const requiredMtime = Math.max(srcMtime, tsconfigMtime);
      // Allow a tiny clock skew / same-second write so a just-built tree is not
      // rejected on filesystems with coarse mtime resolution.
      if (requiredMtime > outMtime + 1) {
        const age = Math.round((requiredMtime - outMtime) / 1000);
        problems.push(
          `${outRel} is ${age}s older than its TypeScript source (or tsconfig) — run \`npm run build\` before the tests`,
        );
      }
    }
  }

  return problems;
}

/** Hard-fails the current suite when `dist/` is missing or partially stale. */
export async function assertFreshBuild() {
  const problems = await buildFreshnessProblems();
  if (problems.length === 0) return;
  fail(`构建产物不是最新的，测试拒绝运行：\n  - ${problems.join('\n  - ')}`);
}

/* ---------------------------------------------------------------------------
 * Nested resource cleanup (TEST-02 / TEST-03)
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
 *
 * Cleanup failures always fail the suite (TEST-02). If both the body and cleanup
 * fail, both errors are preserved in an AggregateError.
 */
export async function withCleanup(body) {
  const stack = [];
  /** @type {Array<{ label: string, promise: Promise<unknown> }>} */
  const lateReleases = [];
  const scope = {
    /** @param {string} label @param {() => unknown} release */
    defer(label, release, { releaseTimeoutMs = CLEANUP_STEP_TIMEOUT_MS } = {}) {
      stack.push({ label, release, releaseTimeoutMs });
    },
    /**
     * Acquire a resource and register its release in one step.
     * On acquisition timeout, any resource that still resolves later is released
     * (TEST-03) so Chromium/Electron launches cannot leak after the deadline.
     */
    async use(label, acquire, release, { timeoutMs = 60000, releaseTimeoutMs = CLEANUP_STEP_TIMEOUT_MS } = {}) {
      const acquirePromise = Promise.resolve().then(() => acquire());
      let resource;
      try {
        resource = await withDeadline(acquirePromise, timeoutMs, `获取资源「${label}」`);
      } catch (err) {
        // Late-arriving resource: release it so the suite does not leave browsers
        // or Electron processes orphaned after a launch timeout (TEST-03).
        lateReleases.push({
          label: `${label}（超时后迟到）`,
          promise: acquirePromise.then(
            (late) => release(late),
            () => {},
          ),
        });
        throw err;
      }
      stack.push({ label, releaseTimeoutMs, release: () => release(resource) });
      return resource;
    },
  };

  let bodyError;
  let bodyResult;
  try {
    bodyResult = await body(scope);
  } catch (err) {
    bodyError = err;
  }

  const errors = [];
  while (stack.length > 0) {
    const { label, release, releaseTimeoutMs } = stack.pop();
    try {
      await withDeadline(release(), releaseTimeoutMs ?? CLEANUP_STEP_TIMEOUT_MS, `清理「${label}」`);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(`${label}: ${String(err)}`));
      // Keep the label on the message for the AggregateError summary.
      if (errors[errors.length - 1] && !String(errors[errors.length - 1].message).includes(label)) {
        errors[errors.length - 1] = new Error(`${label}: ${errors[errors.length - 1].message}`);
      }
    }
  }

  // Drain late-release promises from timed-out acquisitions (best-effort, with budget).
  for (const late of lateReleases) {
    try {
      await withDeadline(late.promise, CLEANUP_STEP_TIMEOUT_MS, `清理「${late.label}」`);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(`${late.label}: ${String(err)}`));
    }
  }

  if (bodyError && errors.length > 0) {
    throw new AggregateError(
      [bodyError, ...errors],
      `测试失败，且清理阶段也有错误：${errors.map((e) => e.message).join('; ')}`,
    );
  }
  if (bodyError) throw bodyError;
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `[cleanup] 以下资源没有干净释放：\n  - ${errors.map((e) => e.message).join('\n  - ')}`,
    );
  }
  return bodyResult;
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

/**
 * Standalone temp-dir helper for suites that do not already own a cleanup scope
 * (TEST-07). Set MFH_KEEP_TEST_TMP=1 to retain the directory for debugging.
 */
export async function withTempDir(prefix, body) {
  const keep = process.env.MFH_KEEP_TEST_TMP === '1';
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    if (keep) {
      console.error(`[MFH_KEEP_TEST_TMP] retained ${dir}`);
    } else {
      await rm(dir, { recursive: true, force: true }).catch((err) => {
        throw new Error(`清理临时目录失败 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
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
