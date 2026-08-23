import fs from 'node:fs';
import path from 'node:path';
import type { ParsedMail } from 'mailparser';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { State } from '../state.js';
import { isMailHash, msgIdHash as msgIdHashFn } from '../util/hash.js';
import { csvCell, ensureCsvSchema, parseCsv, readCsvRows, rewriteCsvRows } from '../util/csv.js';
import { appendCsvBlockDurable } from '../download/archiveJournal.js';
import {
  appendCsvBlock,
  ensureDir,
  hardenFile,
  PENDING_CSV_HEADER,
  PENDING_CSV_LEGACY,
  withCsvRetry,
} from './csvDurability.js';
import { sanitizePendingReason } from './retryFetch.js';

// ---------------------------------------------------------------------------
// 待确认队列
// ---------------------------------------------------------------------------

function writePendingEml(raw: Buffer | undefined, pendingDir: string, hash: string): void {
  ensureDir(pendingDir);
  const emlPath = path.join(pendingDir, `${hash}.eml`);
  const tmpPath = `${emlPath}.tmp`;

  if (fs.existsSync(emlPath) && fs.statSync(emlPath).size > 0) return;

  fs.writeFileSync(tmpPath, raw ?? Buffer.from(''), { mode: process.platform === 'win32' ? undefined : 0o600 });
  hardenFile(tmpPath);
  fs.renameSync(tmpPath, emlPath);
  hardenFile(emlPath);
}

/** CORE-03d：按显式 mailHash 去重，禁止仅靠 messageId/date/from/subject 折叠。 */
function pendingCsvContainsHash(csvPath: string, mailHash: string): boolean {
  if (!fs.existsSync(csvPath) || mailHash.length === 0) return false;
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  if (records.length === 0) return false;
  const header = records[0] ?? [];
  const iMailHash = header.indexOf('mailHash');
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    if (iMailHash >= 0) {
      if ((cols[iMailHash] ?? '') === mailHash) return true;
    } else {
      // 旧 schema：无 mailHash 列时无法可靠去重；不按 envelope 折叠。
    }
  }
  return false;
}

function fillPendingMailHash(row: Record<string, string>): Record<string, string> {
  if (row.mailHash && row.mailHash.length > 0) return row;
  const messageId = row.messageId ?? '';
  // 超大邮件路径曾把 hash 写在 messageId 位。
  if (isMailHash(messageId)) {
    return { ...row, mailHash: messageId.toLowerCase() };
  }
  const legacy = msgIdHashFn(
    messageId.length > 0 ? messageId : undefined,
    row.from ?? '',
    row.date ?? '',
    row.subject ?? '',
  );
  return { ...row, mailHash: legacy };
}

/** 当前 schema 下 blank mailHash 行补齐（append 升级漏填时的语义幂等修复）。 */
function repairBlankPendingMailHashes(csvPath: string): void {
  if (!fs.existsSync(csvPath)) return;
  try {
    if (fs.statSync(csvPath).size === 0) return;
  } catch {
    return;
  }
  const rows = readCsvRows(csvPath);
  if (rows.length === 0) return;
  let dirty = false;
  const fixed = rows.map((row) => {
    if ((row.mailHash ?? '').trim().length > 0) return row;
    dirty = true;
    return fillPendingMailHash(row);
  });
  if (!dirty) return;
  withCsvRetry(() => rewriteCsvRows(csvPath, PENDING_CSV_HEADER, fixed));
  hardenFile(csvPath);
}

function ensurePendingSchema(csvPath: string): void {
  ensureCsvSchema(csvPath, PENDING_CSV_HEADER, {
    upgradeFrom: PENDING_CSV_LEGACY,
    upgradeRow: fillPendingMailHash,
  });
  // 若此前经无 upgradeRow 的路径「只升了表头」，此处把 blank mailHash 补上。
  repairBlankPendingMailHashes(csvPath);
}

function appendPendingCsv(
  csvPath: string,
  mail: { messageId: string; date: string; from: string; subject: string },
  reason: string,
  mailHash: string,
): void {
  // 先 ensure+repair，再按 mailHash 去重，保证重试旧 pending 不会 append 重复行。
  ensurePendingSchema(csvPath);
  if (pendingCsvContainsHash(csvPath, mailHash)) return;
  const line = [mailHash, mail.messageId, mail.date, mail.from, mail.subject, reason].map(csvCell).join(',') + '\n';
  appendCsvBlock(csvPath, PENDING_CSV_HEADER, [line], {
    upgradeFrom: PENDING_CSV_LEGACY,
    upgradeRow: fillPendingMailHash,
  });
}

/**
 * 写入待确认记录。返回 true 表示 `.eml` 与 `pending.csv` 都已落盘。
 * 只有在「完整归档成功」或「pending 记录确实落盘」之后才允许提交
 * `processedHashes`，否则这封邮件既没有归档也没有待确认记录却不再重试（APP-03）。
 */
export function persistPending(
  mail: ParsedMail,
  cfg: Config,
  hash: string,
  reason: string,
  log: Logger,
  raw: Buffer | undefined,
): boolean {
  try {
    const safeReason = sanitizePendingReason(reason);
    writePendingEml(raw, cfg.paths.pending, hash);
    appendPendingCsv(
      path.join(cfg.paths.pending, 'pending.csv'),
      {
        messageId: mail.messageId || '',
        date: mail.date?.toISOString() || '',
        from: mail.from?.text || '',
        subject: mail.subject || '',
      },
      safeReason,
      hash,
    );
    return true;
  } catch (err) {
    log.warn(`Pending write failed for ${hash}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * EXT-05 / CORE-03e：超大邮件等无法 parse 的路径写入 durable pending。
 * 必须使用 fetch 时的 fileHash 身份，不得重算成另一把键。
 * 失败抛错，由调用方计 failed 并返回非 0。
 */
export function persistPendingDurable(opts: {
  cfg: Config;
  mailHash: string;
  reason: string;
  raw: Buffer;
  messageId?: string;
  date?: string;
  from?: string;
  subject?: string;
}): void {
  const { cfg, mailHash, raw } = opts;
  const safeReason = sanitizePendingReason(opts.reason);
  writePendingEml(raw, cfg.paths.pending, mailHash);
  const csvPath = path.join(cfg.paths.pending, 'pending.csv');
  ensureDir(path.dirname(csvPath));
  withCsvRetry(() => {
    ensurePendingSchema(csvPath);
    if (pendingCsvContainsHash(csvPath, mailHash)) return;
    const line = [
      mailHash,
      opts.messageId ?? '',
      opts.date ?? '',
      opts.from ?? '',
      opts.subject ?? '',
      safeReason,
    ].map(csvCell).join(',') + '\n';
    appendCsvBlockDurable(csvPath, PENDING_CSV_HEADER, [line]);
  });
  hardenFile(csvPath);
}

export function commitProcessed(state: State, hash: string, saveState: () => void): void {
  if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
  saveState();
}
