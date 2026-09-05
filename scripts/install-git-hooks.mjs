import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit opt-in avoids install-time prompts and mutation of CI/shared Git hooks.
if (!process.env.CI && process.env.MFH_INSTALL_GIT_HOOKS === '1' && !process.env.SKIP_SIMPLE_GIT_HOOKS) {
  const cli = fileURLToPath(new URL('../node_modules/simple-git-hooks/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
