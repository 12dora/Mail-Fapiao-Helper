import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { assertArchiveTransactionsRecovered } from '../download/archiveJournal.js';
import { log } from '../log.js';
import { organizeFromOcrResults } from '../rename/rename.js';
import { parseOrganizeArgs, type OrganizeOpts } from './args.js';
import { acquireCommandLock } from './lock.js';
import { ORGANIZE_USAGE } from './usage.js';

export async function cmdOrganize(argv: string[]): Promise<number> {
  let parsed: OrganizeOpts | 'help';
  try { parsed = parseOrganizeArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(ORGANIZE_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(ORGANIZE_USAGE); return 0; }
  let cfg: Config;
  try { cfg = loadConfig(resolve(parsed.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  if (!acquireCommandLock('organize', { configPath: parsed.configPath }, cfg)) return 2;
  try {
    assertArchiveTransactionsRecovered(resolve(cfg.paths.invoices));
    const summary = organizeFromOcrResults(cfg, log, { resultsCsv: parsed.resultsCsv, outDir: parsed.outDir, applyRename: parsed.applyRename });
    log.info(`Organize complete: scanned=${summary.scanned}, copied=${summary.copied}, skipped=${summary.skipped}, failed=${summary.failed}`);
    return summary.failed > 0 ? 1 : 0;
  } catch (e) { log.error((e as Error).message); return 1; }
}
