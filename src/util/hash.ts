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
 *
 * 升级兼容：旧档案使用 12 位键；新写入在有 raw 时用 32 位。
 *
 * **非对称读写（CORE-03）**：
 * - **写** state：只记 `primary` 一条（`addProcessed` / `addFetched`），集合基数 = 邮件数；
 * - **读** state：用 `aliases` 做 `hasProcessedAny` / `hasFetchedAny`，旧 12 位条目仍能命中，
 *   升级用户不会重处理、也不会把别名批量回写进 state。
 * 台账须显式写 `mailHash`（primary），禁止仅凭 Message-Id 判定「已处理」。
 */

/** 合法邮件身份：历史 12 位，或 CORE-03 的 32 位（128 bit 截断）。大小写不敏感。 */
export const MAIL_HASH_RE = /^[0-9a-f]{12}$|^[0-9a-f]{32}$/i;

export function isMailHash(value: string): boolean {
  return MAIL_HASH_RE.test(value);
}

/** 始终走历史 12 位 sha1 路径（无 raw）。用于别名与升级前档案对齐。 */
export function legacyMsgIdHash(
  messageId: string | undefined,
  from: string,
  date: string,
  subject: string,
): string {
  const mid = messageId && messageId.length > 0 ? messageId : '';
  const key = mid.length > 0 ? mid : `${from}|${date}|${subject}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

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
  return legacyMsgIdHash(messageId, from, date, subject);
}

function hasBytes(raw: BinaryLike): boolean {
  if (typeof raw === 'string') return raw.length > 0;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return raw.length > 0;
  if (raw instanceof ArrayBuffer) return raw.byteLength > 0;
  if (ArrayBuffer.isView(raw)) return raw.byteLength > 0;
  return true;
}

/** 一封邮件在运行期的全部已知身份（primary + 升级别名）。 */
export interface MailIdentity {
  /**
   * 新写入使用的规范身份：有 raw 时为 32 位内容绑定 hash；
   * 否则优先沿用缓存文件名上的合法 hash（保持 fetch 时身份）；再否则 legacy 12 位。
   */
  primary: string;
  /**
   * primary、legacy 12 位、缓存文件名等全部别名。
   * 仅用于**读侧**匹配（state / --only-mail / 并发去重），禁止整组写入 state。
   */
  aliases: readonly string[];
  /** 始终可重算的历史 12 位键（无 raw）。 */
  legacy: string;
}

export interface ResolveMailIdentityInput {
  messageId?: string | undefined;
  from: string;
  date: string;
  subject: string;
  raw?: BinaryLike | undefined;
  /**
   * 缓存 `.eml` 的 basename（无扩展名）。fetch 写入的文件名即当时的身份；
   * 解析失败（超大邮件）时必须优先用它，避免与 fetch 时 identity 分叉（CORE-03e）。
   */
  fileHash?: string | undefined;
}

/**
 * 解析一封邮件的完整身份集合。
 *
 * primary 选择顺序（保证升级不重处理、fetch/run 不换键）：
 * 1. 合法 `fileHash`（缓存 `.eml` 文件名 = fetch 时写入的身份）—— operational 主键；
 * 2. 否则有 raw → 32 位内容绑定 hash；
 * 3. 否则 legacy 12 位。
 *
 * 有 raw 时始终把 32 位 computed 与 legacy 12 位收进 aliases，
 * 以便 `--only-mail` / state 在两种宽度下都能命中。
 */
export function resolveMailIdentity(input: ResolveMailIdentityInput): MailIdentity {
  const mid = input.messageId && input.messageId.length > 0 ? input.messageId : undefined;
  const legacy = legacyMsgIdHash(mid, input.from, input.date, input.subject);
  const aliases = new Set<string>();
  aliases.add(legacy);

  const fileHash = input.fileHash && isMailHash(input.fileHash)
    ? input.fileHash.toLowerCase()
    : undefined;
  if (fileHash) aliases.add(fileHash);

  let computed: string | undefined;
  if (input.raw !== undefined && input.raw !== null && hasBytes(input.raw)) {
    computed = msgIdHash(mid, input.from, input.date, input.subject, input.raw);
    aliases.add(computed);
  }

  // 缓存文件名优先：避免「fetch 用 Message-Id+raw、run 解析失败后只用 raw」分叉成两把键。
  const primary = fileHash ?? computed ?? legacy;

  return { primary, aliases: Object.freeze([...aliases]), legacy };
}

/** `--only-mail` / pending 重试：接受 12 或 32 位，匹配任意别名。 */
export function identityMatches(onlyMail: string, identity: MailIdentity): boolean {
  const target = onlyMail.trim().toLowerCase();
  if (!isMailHash(target)) return false;
  if (identity.primary.toLowerCase() === target) return true;
  for (const a of identity.aliases) {
    if (a.toLowerCase() === target) return true;
  }
  return false;
}

/** state 命中：任意别名在集合中即视为已处理/已抓取。 */
export function identityInSet(identity: MailIdentity, set: { has(h: string): boolean }): boolean {
  if (set.has(identity.primary)) return true;
  for (const a of identity.aliases) {
    if (set.has(a)) return true;
  }
  return false;
}

/** Stable short fingerprint of a document's bytes, used to distinguish distinct
 *  documents in one email while still collapsing true reprocessing duplicates. */
export function contentHash(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex').slice(0, 12);
}
