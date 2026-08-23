import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { log } from '../log.js';
import { pendingEmlExists, summarizePending } from '../pending/summary.js';
import { parsePendingArgs, type PendingOpts } from './args.js';
import { PENDING_USAGE } from './usage.js';

export async function cmdPending(argv: string[]): Promise<number> {
  let parsed: PendingOpts | 'help';
  try { parsed = parsePendingArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(PENDING_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(PENDING_USAGE); return 0; }
  let cfg: Config;
  try { cfg = loadConfig(resolve(parsed.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  const summary = summarizePending(cfg);
  if (parsed.json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return 0; }
  process.stdout.write(`Pending queue: ${summary.total} (${summary.csvPath})\n`);
  for (const group of summary.groups) {
    process.stdout.write(`${group.title}: ${group.count} action=${group.action}\n`);
    process.stdout.write(`  ${group.description}\n`);
    for (const row of group.rows) {
      const eml = pendingEmlExists(cfg, row) ? 'eml=yes' : 'eml=no';
      process.stdout.write(`  ${row.hash} date=${row.date} from="${row.from}" subject="${row.subject}" reason=${row.reason} ${eml}\n`);
    }
  }
  return 0;
}
