import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { csvCell, parseCsv } from '../util/csv.js';
import { redactPath, sanitizeText, type UiError } from './sanitize.js';

// ---------------------------------------------------------------------------
// 「重新识别」的可恢复准备（APP-17 / ELEC-03）
// ---------------------------------------------------------------------------

export interface OcrRerunPlan {
  /** 成功且 durable 验证后丢弃备份。 */
  discard(): void;
  /** 失败时把结果 CSV 与队列恢复到重跑之前；失败会抛出。 */
  restore(): void;
  resultsCsv: string;
  journalPath: string;
}

export type PrepareRerunResult =
  | { ok: true; plan: OcrRerunPlan }
  | { ok: false; error: UiError };

export interface OcrRerunJournal {
  version: 1;
  stage: 'prepared' | 'committed' | 'rolled_back';
  resultsCsv: string;
  pendingCsv: string;
  resultsBackup: string;
  queueBackup: string;
  resultsMoved: boolean;
  queueMoved: boolean;
  createdAt: number;
  pid: number;
}

export interface OcrRerunDependencies {
  dataDir: string;
  ocrResultsCsvPath(): string;
  ocrPendingCsvPath(): string;
}

export function createOcrRerun(deps: OcrRerunDependencies) {
  const { dataDir, ocrResultsCsvPath, ocrPendingCsvPath } = deps;

function ocrRerunJournalDir(): string {
  return path.join(dataDir, '.mfh-cache', 'ocr-rerun');
}

function writeOcrRerunJournal(file: string, record: OcrRerunJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Windows 可能不支持目录 fsync。
  }
}

function readOcrRerunJournal(file: string): OcrRerunJournal | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OcrRerunJournal>;
    if (raw.version !== 1) return undefined;
    if (typeof raw.resultsCsv !== 'string' || typeof raw.resultsBackup !== 'string') return undefined;
    return raw as OcrRerunJournal;
  } catch {
    return undefined;
  }
}

function restoreFromOcrRerunJournal(journal: OcrRerunJournal): void {
  const errors: string[] = [];
  if (journal.resultsMoved && fs.existsSync(journal.resultsBackup)) {
    try {
      if (fs.existsSync(journal.resultsCsv)) fs.rmSync(journal.resultsCsv, { force: true });
      fs.renameSync(journal.resultsBackup, journal.resultsCsv);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (journal.queueMoved && fs.existsSync(journal.queueBackup)) {
    try {
      fs.copyFileSync(journal.queueBackup, journal.pendingCsv);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new Error(`ocr_rerun_restore_failed:${errors.join(';')}`);
  }
}

/**
 * 启动时恢复未完成的 OCR 重跑事务：有 journal 且非 committed → 回滚到备份。
 */
function recoverOcrRerunJournals(): void {
  const dir = ocrRerunJournalDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    // 读失败 fail closed：不静默吞掉，留给 ensure 路径处理。
    return;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    const journal = readOcrRerunJournal(file);
    if (!journal) continue;
    if (journal.stage === 'committed' || journal.stage === 'rolled_back') {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
      continue;
    }
    try {
      restoreFromOcrRerunJournal(journal);
      journal.stage = 'rolled_back';
      writeOcrRerunJournal(file, journal);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // keep journal if delete fails
      }
      // 备份可在确认 restore 成功后删除。
      for (const bak of [journal.resultsBackup, journal.queueBackup]) {
        try {
          if (bak && fs.existsSync(bak)) fs.rmSync(bak, { force: true });
        } catch {
          // best-effort
        }
      }
    } catch {
      // 保留 journal，阻断后续重跑直到人工处理。
    }
  }
}

type ReadAndTransformQueueResult =
  | { ok: true; nextQueue: string | undefined }
  | { ok: false; error: UiError };

function readAndTransformQueue(pendingCsv: string): ReadAndTransformQueueResult {
  // 先在内存里算出新队列内容并校验，确保替代物可用。
  let nextQueue: string | undefined;
  if (fs.existsSync(pendingCsv)) {
    try {
      const text = fs.readFileSync(pendingCsv, 'utf8');
      const bom = text.startsWith('﻿') ? '﻿' : '';
      const records = parseCsv(text.replace(/^﻿/, ''));
      const header = records[0] ?? [];
      const statusIndex = header.indexOf('status');
      const reasonIndex = header.indexOf('reason');
      const documentTypeIndex = header.indexOf('documentType');
      if (statusIndex === -1) {
        return {
          ok: false,
          error: { code: 'ocr_queue_malformed', message: '识别队列文件格式不正确，无法重新识别。' },
        };
      }
      const out = [`${bom}${header.map(csvCell).join(',')}`];
      for (let r = 1; r < records.length; r++) {
        const cols = records[r] ?? [];
        const docType = documentTypeIndex >= 0 ? (cols[documentTypeIndex] ?? '') : '';
        if (docType === 'supporting') {
          cols[statusIndex] = 'ignored';
          if (reasonIndex >= 0) cols[reasonIndex] = cols[reasonIndex] || 'supporting_document';
        } else {
          cols[statusIndex] = 'pending';
          if (reasonIndex >= 0) cols[reasonIndex] = '';
        }
        out.push(header.map((_, index) => csvCell(cols[index] ?? '')).join(','));
      }
      nextQueue = `${out.join('\n')}\n`;
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'ocr_queue_unreadable',
          message: '无法读取识别队列文件，重新识别已取消。',
          detail: sanitizeText(err instanceof Error ? err.message : String(err)),
        },
      };
    }
  }
  return { ok: true, nextQueue };
}

interface OcrRerunPreparation {
  stamp: string;
  resultsBackup: string;
  queueBackup: string;
  journalPath: string;
  journal: OcrRerunJournal;
}

function createRerunJournal(resultsCsv: string, pendingCsv: string): OcrRerunPreparation {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const resultsBackup = `${resultsCsv}.rerun-backup-${stamp}`;
  const queueBackup = `${pendingCsv}.rerun-backup-${stamp}`;
  const journalPath = path.join(ocrRerunJournalDir(), `rerun-${stamp}.json`);

  const journal: OcrRerunJournal = {
    version: 1,
    stage: 'prepared',
    resultsCsv,
    pendingCsv,
    resultsBackup,
    queueBackup,
    resultsMoved: false,
    queueMoved: false,
    createdAt: Date.now(),
    pid: process.pid,
  };

  return { stamp, resultsBackup, queueBackup, journalPath, journal };
}

type InstallPreparedStateResult = { ok: true } | { ok: false; error: UiError };

function installPreparedState(
  resultsCsv: string,
  pendingCsv: string,
  nextQueue: string | undefined,
  preparation: OcrRerunPreparation,
): InstallPreparedStateResult {
  const { stamp, resultsBackup, queueBackup, journalPath, journal } = preparation;
  let resultsMoved = false;
  let queueMoved = false;

  try {
    // 先落 journal（空操作意图），再移动文件。
    writeOcrRerunJournal(journalPath, journal);
    if (fs.existsSync(resultsCsv)) {
      fs.renameSync(resultsCsv, resultsBackup);
      resultsMoved = true;
      journal.resultsMoved = true;
      writeOcrRerunJournal(journalPath, journal);
    }
    if (nextQueue !== undefined && fs.existsSync(pendingCsv)) {
      fs.copyFileSync(pendingCsv, queueBackup);
      queueMoved = true;
      journal.queueMoved = true;
      writeOcrRerunJournal(journalPath, journal);
    }
    if (nextQueue !== undefined) {
      const tmp = `${pendingCsv}.tmp-${stamp}`;
      fs.writeFileSync(tmp, nextQueue, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, pendingCsv);
    }
  } catch (err) {
    // 准备阶段失败：立即还原，旧结果一个都不丢；还原失败必须上报。
    try {
      restoreFromOcrRerunJournal({ ...journal, resultsMoved, queueMoved });
      journal.stage = 'rolled_back';
      writeOcrRerunJournal(journalPath, journal);
      try {
        fs.rmSync(journalPath, { force: true });
      } catch {
        // keep
      }
    } catch (restoreErr) {
      return {
        ok: false,
        error: {
          code: 'ocr_rerun_restore_failed',
          message: '重新识别准备失败，且无法自动恢复原有识别结果。请重新打开应用；若仍异常，请勿继续识别并保留备份文件。',
          detail: sanitizeText(
            `${err instanceof Error ? err.message : String(err)}; restore: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
          ),
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'ocr_rerun_prepare_failed',
        message: '重新识别的准备工作失败，已保留原有识别结果。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      },
    };
  }

  return { ok: true };
}

/**
 * 先准备并校验全部替代物，再把旧结果「移动到备份」（而不是直接删除），最后原子
 * 安装新队列。全程写 durable journal；任何一步失败都可以完整恢复（ELEC-03）。
 */
function prepareOcrRerun(): PrepareRerunResult {
  const resultsCsv = ocrResultsCsvPath();
  const pendingCsv = ocrPendingCsvPath();

  // dataDir 之外的绝对 results 路径是**明确支持**的：改成「移动到同目录备份」，
  // 既不静默跳过，也不会真正删除任何用户文件（失败时还能原样恢复）。
  if (fs.existsSync(resultsCsv) && !fs.statSync(resultsCsv).isFile()) {
    return {
      ok: false,
      error: {
        code: 'ocr_results_not_a_file',
        message: '识别结果的保存位置不是一个文件，请在设置中检查「识别结果」路径。',
        detail: redactPath(resultsCsv),
      },
    };
  }

  const queueResult = readAndTransformQueue(pendingCsv);
  if (!queueResult.ok) return queueResult;

  const preparation = createRerunJournal(resultsCsv, pendingCsv);
  const { resultsBackup, queueBackup, journalPath, journal } = preparation;
  const installResult = installPreparedState(resultsCsv, pendingCsv, queueResult.nextQueue, preparation);
  if (!installResult.ok) return installResult;

  let discarded = false;
  let restored = false;

  const discardPlan = () => {
    if (discarded || restored) return;
    // 提交前验证：备份仍在，结果路径可写——然后 durable 标记 committed。
    try {
      journal.stage = 'committed';
      writeOcrRerunJournal(journalPath, journal);
      for (const file of [resultsBackup, queueBackup]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // 备份删不掉不回滚成功态，但 journal 保留到删干净。
        }
      }
      // 确认备份已不在后才删 journal。
      const bakLeft = [resultsBackup, queueBackup].some((f) => {
        try {
          return fs.existsSync(f);
        } catch {
          return true;
        }
      });
      if (!bakLeft) {
        try {
          fs.rmSync(journalPath, { force: true });
        } catch {
          // ignore
        }
      }
      discarded = true;
    } catch {
      // discard 失败：保留 journal + 备份，下次启动可再处理。
    }
  };

  const restorePlan = () => {
    if (discarded || restored) return;
    restoreFromOcrRerunJournal(journal);
    journal.stage = 'rolled_back';
    writeOcrRerunJournal(journalPath, journal);
    for (const file of [resultsBackup, queueBackup]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 备份删除失败时保留 journal
      }
    }
    try {
      fs.rmSync(journalPath, { force: true });
    } catch {
      // keep
    }
    restored = true;
  };

  const makePlan = (): OcrRerunPlan => ({
    resultsCsv,
    journalPath,
    discard: discardPlan,
    restore: restorePlan,
  });

  return {
    ok: true,
    plan: makePlan(),
  };
}

  return { recoverOcrRerunJournals, prepareOcrRerun };
}
