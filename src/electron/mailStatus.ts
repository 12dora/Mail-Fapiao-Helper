import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { readCsvRows } from '../util/csv.js';
import { isMailHash, msgIdHash } from '../util/hash.js';
import { loadState } from '../state.js';
import { summarizePending } from '../pending/summary.js';

export type MailStatus = 'archived' | 'pending' | 'unprocessed' | 'ignored';
export interface MailStatusEntry { status: MailStatus; documentCount: number; mailOpenable: boolean }

export function mailHashForRow(row: Record<string, string>): string {
  const explicit = row.mailHash || row.hash || '';
  if (isMailHash(explicit)) return explicit.toLowerCase();
  if (isMailHash(row.messageId || '')) return row.messageId!.toLowerCase();
  return msgIdHash(row.messageId || undefined, row.from || '', row.date || '', row.subject || '');
}

export function mailStatusFor(index: Map<string, MailStatusEntry>, hash: string): MailStatusEntry {
  return index.get(hash.toLowerCase()) ?? { status: 'unprocessed', documentCount: 0, mailOpenable: false };
}

export function buildMailStatusIndex(cfg: Config, cwd = process.cwd()): Map<string, MailStatusEntry> {
  const index = new Map<string, MailStatusEntry>();
  const ensure = (hash: string) => {
    hash = hash.toLowerCase();
    if (!index.has(hash)) index.set(hash, { status: 'unprocessed', documentCount: 0, mailOpenable: false });
    return index.get(hash)!;
  };
  const inbox = readCsvRows(path.resolve(cwd, cfg.paths.samples, 'INDEX.csv'));
  const messageHashes = new Map(inbox.filter(r => r.messageId).map(r => [r.messageId!, mailHashForRow(r)]));
  for (const row of inbox) ensure(mailHashForRow(row));
  const state = loadState(path.resolve(cwd, 'state.json'));
  for (const hash of state.fetchedHashes) ensure(hash);
  for (const hash of state.processedHashes) ensure(hash).status = 'ignored';
  for (const group of summarizePending(cfg, cwd).groups) {
    for (const row of group.rows) ensure(row.hash).status = 'pending';
  }
  for (const row of readCsvRows(path.resolve(cwd, cfg.output.csv))) {
    const hash = row.mailHash ? mailHashForRow(row) : messageHashes.get(row.messageId || '') || mailHashForRow(row);
    const entry = ensure(hash);
    entry.status = 'archived';
    entry.documentCount++;
  }
  for (const folder of [cfg.paths.samples, cfg.paths.pending]) {
    try {
      for (const entry of fs.readdirSync(path.resolve(cwd, folder), { withFileTypes: true })) {
        const hash = entry.name.replace(/\.eml$/, '');
        if (entry.isFile() && entry.name.endsWith('.eml') && isMailHash(hash)) ensure(hash).mailOpenable = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return index;
}
