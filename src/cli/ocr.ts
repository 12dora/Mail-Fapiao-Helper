import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { assertArchiveTransactionsRecovered } from '../download/archiveJournal.js';
import { log } from '../log.js';
import { stopEfapiaoServices } from '../ocr/efapiao.js';
import { runOcrPending } from '../ocr/runner.js';
import { summarizeOcr } from '../ocr/summary.js';
import { parseOcrArgs, type OcrOpts } from './args.js';
import { clearOcrRuntimePid, writeOcrRuntimePid } from './lifecycle.js';
import { acquireCommandLock } from './lock.js';
import { OCR_USAGE } from './usage.js';

export async function cmdOcr(argv: string[]): Promise<number> {
  let parsed: OcrOpts | 'help';
  try { parsed = parseOcrArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(OCR_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(OCR_USAGE); return 0; }
  let cfg: Config;
  try { cfg = loadConfig(resolve(parsed.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  // `ocr summary` 只读队列与结果，不占锁；`ocr run` 会写结果 CSV 与队列。
  if (parsed.command === 'run' && !acquireCommandLock('ocr', { configPath: parsed.configPath }, cfg)) return 2;
  try {
    if (parsed.command === 'summary') {
      const summary = summarizeOcr(cfg);
      if (parsed.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      else {
        process.stdout.write(`OCR queue: ${summary.total} (${summary.pendingCsv})\n`);
        process.stdout.write(`  recognized=${summary.recognized} failed=${summary.failed} ignored=${summary.ignored} pending=${summary.pending}\n`);
        process.stdout.write(`  results=${summary.resultsCsv}\n`);
        process.stdout.write('By document type:\n');
        for (const group of summary.byDocumentType) process.stdout.write(`  ${group.key}: ${group.count}\n`);
        if (summary.bySupportingReason.length > 0) {
          process.stdout.write('Ignored supporting documents:\n');
          for (const group of summary.bySupportingReason) process.stdout.write(`  ${group.key}: ${group.count}\n`);
        }
        if (summary.byFailureReason.length > 0) {
          process.stdout.write('Failure reasons:\n');
          for (const group of summary.byFailureReason) {
            process.stdout.write(`  ${group.key}: ${group.count}\n`);
            for (const example of group.examples) process.stdout.write(`    ${example.hash} ${example.filename} subject="${example.subject}" reason=${example.reason}\n`);
          }
        }
      }
      return 0;
    }
    assertArchiveTransactionsRecovered(resolve(cfg.paths.invoices));
    writeOcrRuntimePid(cfg);
    const summary = await runOcrPending(cfg, log, { force: parsed.force, singleItem: parsed.singleItem, concurrency: parsed.concurrency });
    log.info(`OCR complete: scanned=${summary.scanned}, parsed=${summary.parsed}, skipped=${summary.skipped}, failed=${summary.failed}, updated=${summary.updated}`);
    if (summary.failed > 0 && !parsed.allowParseFailures) return 1;
    return 0;
  } catch (e) { log.error((e as Error).message); return 1; }
  finally {
    // Kill any efapiao serve child we started so it does not outlive the CLI.
    stopEfapiaoServices();
    clearOcrRuntimePid();
  }
}
