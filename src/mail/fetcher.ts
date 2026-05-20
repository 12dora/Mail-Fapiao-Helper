import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';

export interface RawMail {
  uid: number;
  raw: Buffer;
  messageId: string | undefined;
  from: string;
  date: Date;
  subject: string;
  hasAttachment: boolean;
  bodyLinkCount: number;
}

export interface DateWindow {
  since: Date;
  // IMAP BEFORE is exclusive on the date (treats date-only at 00:00); we
  // pass the day *after* untilInclusive so the user's --until is inclusive.
  before: Date | undefined;
}

export function resolveDateWindow(cfg: Config, now: Date = new Date()): DateWindow {
  let since: Date;
  if (cfg.filter.since) {
    since = new Date(Date.parse(cfg.filter.since));
  } else {
    since = new Date(now.getTime() - cfg.filter.sinceDays * 86_400_000);
  }
  let before: Date | undefined;
  if (cfg.filter.until) {
    const t = Date.parse(cfg.filter.until);
    // make --until inclusive by advancing one day
    before = new Date(t + 86_400_000);
  }
  return { since, before };
}

function buildSearch(cfg: Config): SearchObject {
  const win = resolveDateWindow(cfg);
  const kws = cfg.filter.keywords;
  const fields: Array<'subject' | 'body'> = [];
  if (cfg.filter.matchSubject) fields.push('subject');
  if (cfg.filter.matchBody) fields.push('body');

  const terms: SearchObject[] = [];
  for (const kw of kws) {
    for (const f of fields) {
      terms.push({ [f]: kw } as SearchObject);
    }
  }
  let keywordPart: SearchObject;
  if (terms.length === 0) {
    keywordPart = {};
  } else if (terms.length === 1) {
    keywordPart = terms[0]!;
  } else {
    let acc: SearchObject = { or: [terms[0]!, terms[1]!] };
    for (let i = 2; i < terms.length; i++) {
      acc = { or: [acc, terms[i]!] };
    }
    keywordPart = acc;
  }
  const out: SearchObject = { ...keywordPart, since: win.since };
  if (win.before) out.before = win.before;
  return out;
}

function countLinks(html: string | false | undefined, text: string | undefined): number {
  let n = 0;
  if (typeof html === 'string' && html.length > 0) {
    const m = html.match(/<a\s[^>]*href\s*=/gi);
    if (m) n += m.length;
  }
  if (typeof text === 'string' && text.length > 0) {
    const m = text.match(/https?:\/\/[^\s<>"')]+/g);
    if (m) n += m.length;
  }
  return n;
}

export async function* fetchMails(cfg: Config, log: Logger): AsyncIterable<RawMail> {
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.tls,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock(cfg.imap.mailbox);
  try {
    const search = buildSearch(cfg);
    const win = resolveDateWindow(cfg);
    log.info(`IMAP SEARCH ${JSON.stringify(search)}`);
    const uids = await client.search(search, { uid: true });
    if (!uids || uids.length === 0) {
      log.info('IMAP SEARCH: 0 matches');
      return;
    }
    log.info(`IMAP SEARCH: ${uids.length} matches`);

    for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true })) {
      if (!msg.source) continue;
      const raw = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
      let parsed;
      try {
        parsed = await simpleParser(raw);
      } catch (e) {
        log.warn(`parse failed for uid=${msg.uid}: ${(e as Error).message}`);
        continue;
      }
      const env = msg.envelope;
      const from = parsed.from?.text
        ?? (env?.from?.map((a) => a.address ?? '').join(',') ?? '');
      const subject = parsed.subject ?? env?.subject ?? '';
      const date = parsed.date ?? env?.date ?? new Date(0);
      const messageId = parsed.messageId ?? env?.messageId ?? undefined;
      const hasAttachment = (parsed.attachments?.length ?? 0) > 0;
      const bodyLinkCount = countLinks(parsed.html, parsed.text);

      // Defensive header-date filter: some servers return messages outside the
      // IMAP SEARCH window (mismatch between INTERNALDATE and the Date header).
      if (date.getTime() < win.since.getTime()) {
        log.info(`skip uid=${msg.uid} date=${date.toISOString()} < since=${win.since.toISOString()}`);
        continue;
      }
      if (win.before && date.getTime() >= win.before.getTime()) {
        log.info(`skip uid=${msg.uid} date=${date.toISOString()} >= before=${win.before.toISOString()}`);
        continue;
      }

      yield {
        uid: msg.uid,
        raw,
        messageId,
        from,
        date,
        subject,
        hasAttachment,
        bodyLinkCount,
      };
    }
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
}
