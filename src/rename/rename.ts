import type { ParsedMail } from 'mailparser';
import { msgIdHash as msgIdHashFn } from '../util/hash.js';

export function msgIdHash(mail: ParsedMail): string {
  return msgIdHashFn(
    mail.messageId ?? undefined,
    mail.from?.text ?? '',
    mail.date?.toISOString() ?? '',
    mail.subject ?? '',
  );
}

export function generateFilename(mail: ParsedMail, index: number): string {
  const hash = msgIdHash(mail);
  return `${hash}-${index}.pdf`;
}
