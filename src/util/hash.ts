import { createHash, type BinaryLike } from 'node:crypto';

/**
 * 邮件身份 hash。
 *
 * CORE-03：仅靠 Message-Id（或 from|date|subject）会把不同邮件确定性折叠成同一
 * 12 位键。有原始字节时把内容指纹并入密钥；真正字节相同的副本才会折叠。
 *
 * - 有 `raw`：`sha256(normalizedMessageId + "\\0" + sha256(raw))` 的前 32 位十六进制
 *   （128 bit），足够区分重复/缺失 Message-Id 的不同邮件。
 * - 无 `raw`：保持历史 12 位 `sha1` 算法，便于从台账列重算旧身份（rebuild-state）。
 */
export function msgIdHash(
  messageId: string | undefined,
  from: string,
  date: string,
  subject: string,
  raw?: BinaryLike,
): string {
  const mid = messageId && messageId.length > 0 ? messageId : '';
  if (raw !== undefined && raw !== null && hasBytes(raw)) {
    const contentFp = createHash('sha256').update(raw).digest('hex');
    const key = mid.length > 0 ? `${mid}\0${contentFp}` : contentFp;
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }
  // 无原始字节：与历史行为一致，供 hashFromLedgerRow 等重算路径使用。
  const key = mid.length > 0 ? mid : `${from}|${date}|${subject}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function hasBytes(raw: BinaryLike): boolean {
  if (typeof raw === 'string') return raw.length > 0;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return raw.length > 0;
  if (raw instanceof ArrayBuffer) return raw.byteLength > 0;
  if (ArrayBuffer.isView(raw)) return raw.byteLength > 0;
  return true;
}

/** Stable short fingerprint of a document's bytes, used to distinguish distinct
 *  documents in one email while still collapsing true reprocessing duplicates. */
export function contentHash(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex').slice(0, 12);
}
