#!/usr/bin/env node
import { log } from './log.js';
import { cmdFetch } from './cli/fetch.js';
import { installSignalHandlers } from './cli/lifecycle.js';
import { releaseDataDirLock } from './cli/lock.js';
import { cmdOcr } from './cli/ocr.js';
import { cmdOrganize } from './cli/organize.js';
import { cmdPending } from './cli/pending.js';
import { cmdRebuildState } from './cli/rebuildState.js';
import { cmdRun } from './cli/run.js';
import { ROOT_USAGE } from './cli/usage.js';

export type { LockTargetOverrides } from './cli/lock.js';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(ROOT_USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'fetch':
        return await cmdFetch(rest);
      case 'run':
        return await cmdRun(rest);
      case 'ocr':
        return await cmdOcr(rest);
      case 'pending':
        return await cmdPending(rest);
      case 'organize':
        return await cmdOrganize(rest);
      case 'rebuild-state':
      case '--rebuild-state':
        return await cmdRebuildState(rest);
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n`);
        process.stderr.write(ROOT_USAGE);
        return 2;
    }
  } finally {
    // 正常结束与异常都要放锁；信号退出由 shutdownManagedServices() 兜底。
    releaseDataDirLock();
  }
}

installSignalHandlers();

main().then(
  (code) => process.exit(code),
  (e) => {
    log.error((e as Error).stack ?? String(e));
    process.exit(1);
  },
);
