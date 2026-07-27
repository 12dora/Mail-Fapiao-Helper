import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { nonInvoiceReason } from './exclude.js';
import { imapSearchSince, resolveDateWindowFromFilter, type DateWindow } from '../util/dateRange.js';

/**
 * 不可信邮件的解析防护（APP-09）：
 * - 超过 RAW_MAIL_PARSE_LIMIT 的原始邮件不进 mailparser，直接按 envelope 降级缓存；
 * - `skipTextLinks` 关掉 linkify-it（已知二次复杂度路径）对正文的扫描；
 * - `maxHtmlLengthToParse` 限制 HTML->文本转换的输入规模；
 * - 解析再加一层超时，避免单封对抗性邮件把抓取循环永久占住。
 */
const RAW_MAIL_PARSE_LIMIT = 32 * 1024 * 1024;
const HTML_PARSE_LIMIT = 8 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 20_000;

export const MAIL_PARSE_OPTIONS = {
  skipTextLinks: true,
  maxHtmlLengthToParse: HTML_PARSE_LIMIT,
} as const;

/** 带超时的 MIME 解析；超时/失败由调用方降级处理，不得丢邮件。 */
export async function parseMailWithGuards(
  raw: Buffer,
): Promise<Awaited<ReturnType<typeof simpleParser>>> {
  if (raw.length > RAW_MAIL_PARSE_LIMIT) {
    throw new Error(`mail_too_large_to_parse:${raw.length}>${RAW_MAIL_PARSE_LIMIT}`);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`mail_parse_timeout:${PARSE_TIMEOUT_MS}ms`)), PARSE_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([simpleParser(raw, MAIL_PARSE_OPTIONS), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 返回尚未填写的 IMAP 凭据字段名（COPY-03：空串代表未配置，不是配置损坏）。 */
export function missingImapCredentials(cfg: Config): string[] {
  const missing: string[] = [];
  if (cfg.imap.host.trim().length === 0) missing.push('IMAP 服务器地址');
  if (cfg.imap.user.trim().length === 0) missing.push('邮箱账号');
  if (cfg.imap.pass.trim().length === 0) missing.push('邮箱授权码');
  return missing;
}

export interface RawMail {
  mailbox: string;
  uid: number;
  raw: Buffer;
  messageId: string | undefined;
  from: string;
  date: Date;
  subject: string;
  hasAttachment: boolean;
  bodyLinkCount: number;
}

export type { DateWindow };

/**
 * 抓取窗口 `[since, before)`（APP-07）。date-only 按本地日历解释，完整 ISO
 * timestamp 保留精确 instant；具体规则见 `src/util/dateRange.ts`。
 */
export function resolveDateWindow(cfg: Config, now: Date = new Date()): DateWindow {
  return resolveDateWindowFromFilter({
    since: cfg.filter.since,
    until: cfg.filter.until,
    sinceDays: cfg.filter.sinceDays,
  }, now);
}

function buildSearch(cfg: Config, win: DateWindow): SearchObject {
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
  // Only send `since` to the server. Some IMAP servers (notably QQ) silently
  // return 0 results when an OR'd keyword expression is combined with a
  // `before:` predicate, even though SINCE+OR works fine. We apply the upper
  // bound (`before`) client-side via the per-message date filter below.
  // 服务端 SINCE 只有「日」粒度，这里放宽到本地午夜避免漏掉当天邮件，精确下界
  // 仍由下面的客户端过滤按同一个 window 判定。
  const out: SearchObject = { ...keywordPart, since: imapSearchSince(win) };
  return out;
}

function listAllMailboxPaths(client: ImapFlow): Promise<string[]> {
  return client.list().then((boxes) => boxes
    .filter((box) => box.listed !== false)
    // Skip non-selectable containers (e.g. Gmail's "[Gmail]" parent); opening
    // them with getMailboxLock throws and would abort the whole fetch.
    .filter((box) => !(box.flags instanceof Set && (box.flags.has('\\Noselect') || box.flags.has('\\NonExistent'))))
    .map((box) => box.path)
    .filter((path) => path.length > 0));
}

/** Coerce a Date or date-string to a real, finite Date; otherwise undefined. */
function validDate(d: string | Date | null | undefined): Date | undefined {
  if (d == null) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isFinite(date.getTime()) ? date : undefined;
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
  const missing = missingImapCredentials(cfg);
  if (missing.length > 0) {
    throw new Error(`尚未配置邮箱：请先在设置中填写 ${missing.join('、')} 后再抓取邮件。`);
  }
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.tls,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: false,
  });

  await client.connect();
  try {
    // IMAP 查询与客户端过滤必须共享同一个窗口对象（APP-07）：先算一次再传下去，
    // 否则两处各自取 now 会得到不一致的边界。
    const win = resolveDateWindow(cfg);
    const search = buildSearch(cfg, win);
    const mailboxes = cfg.imap.mailbox.length > 0
      ? cfg.imap.mailbox
      : await listAllMailboxPaths(client);
    log.info(`IMAP mailboxes: ${JSON.stringify(mailboxes)}`);

    for (const mailbox of mailboxes) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch (e) {
        // Connection-level loss must still honor the IRON RULE and abort;
        // a folder-scoped open failure only skips that folder.
        if (!client.usable) throw e;
        log.warn(`IMAP mailbox="${mailbox}" open failed, skipping: ${(e as Error).message}`);
        continue;
      }
      try {
        log.info(`IMAP SEARCH mailbox="${mailbox}" ${JSON.stringify(search)}`);
        const uids = await client.search(search, { uid: true });
        if (!uids || uids.length === 0) {
          log.info(`IMAP SEARCH mailbox="${mailbox}": 0 matches`);
          continue;
        }
        log.info(`IMAP SEARCH mailbox="${mailbox}": ${uids.length} matches`);

        for await (const msg of client.fetch(uids, { source: true, envelope: true, internalDate: true }, { uid: true })) {
          if (!msg.source) continue;
          const raw = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
          let parsed: Awaited<ReturnType<typeof simpleParser>> | undefined;
          try {
            parsed = await parseMailWithGuards(raw);
          } catch (e) {
            // Degrade instead of dropping: the raw bytes and envelope are still in
            // hand, so cache the .eml (it can be reprocessed later) rather than
            // losing a real invoice email to a MIME-parse failure.
            // 超限/超时同样走这条降级路径：邮件仍会落到缓存并由 pending 流程接手，
            // 但绝不把不可信正文交给解析器（APP-09）。
            log.warn(`parse failed for mailbox="${mailbox}" uid=${msg.uid}, falling back to envelope: ${(e as Error).message}`);
            parsed = undefined;
          }
          const env = msg.envelope;
          const from = parsed?.from?.text
            ?? (env?.from?.map((a) => a.address ?? '').join(',') ?? '');
          const subject = parsed?.subject ?? env?.subject ?? '';
          // Prefer a real header date for filtering; fall back to the server
          // INTERNALDATE (which the SINCE search already matched) for storage so a
          // missing/unparseable Date header can no longer collapse to epoch (1970)
          // and get silently discarded by the window filter below.
          const headerDate = validDate(parsed?.date) ?? validDate(env?.date);
          const date = headerDate ?? validDate(msg.internalDate) ?? new Date(0);
          const messageId = parsed?.messageId ?? env?.messageId ?? undefined;
          const hasAttachment = (parsed?.attachments?.length ?? 0) > 0;
          const bodyLinkCount = parsed ? countLinks(parsed.html, parsed.text) : 0;
          const excludeReason = nonInvoiceReason({ from, subject });
          if (excludeReason) {
            log.info(`exclude mailbox="${mailbox}" uid=${msg.uid} reason=${excludeReason} subject="${subject}"`);
            continue;
          }

          // Defensive header-date filter: some servers return messages outside the
          // IMAP SEARCH window (mismatch between INTERNALDATE and the Date header).
          // Only applied when a real header date exists — an absent/invalid header
          // date means we trust the server's INTERNALDATE match and keep the mail.
          if (headerDate && headerDate.getTime() < win.since.getTime()) {
            log.info(`skip mailbox="${mailbox}" uid=${msg.uid} date=${headerDate.toISOString()} < since=${win.since.toISOString()}`);
            continue;
          }
          if (headerDate && win.before && headerDate.getTime() >= win.before.getTime()) {
            log.info(`skip mailbox="${mailbox}" uid=${msg.uid} date=${headerDate.toISOString()} >= before=${win.before.toISOString()}`);
            continue;
          }

          yield {
            mailbox,
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
      } catch (e) {
        // A SELECT/SEARCH/FETCH failure scoped to one folder must not abort the
        // iteration over the remaining mailboxes; a lost connection still does.
        if (!client.usable) throw e;
        log.warn(`IMAP mailbox="${mailbox}" search/fetch failed, skipping remaining messages: ${(e as Error).message}`);
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
