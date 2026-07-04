import { createHash } from 'node:crypto';

export function msgIdHash(
  messageId: string | undefined,
  from: string,
  date: string,
  subject: string,
): string {
  const key = messageId && messageId.length > 0 ? messageId : `${from}|${date}|${subject}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** Stable short fingerprint of a document's bytes, used to distinguish distinct
 *  documents in one email while still collapsing true reprocessing duplicates. */
export function contentHash(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex').slice(0, 12);
}
