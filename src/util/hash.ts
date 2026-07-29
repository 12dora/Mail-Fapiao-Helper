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
 * - **读** state：用 `evidence` 做 `hasProcessedAny` / `hasFetchedAny`（见下），禁止把
 *   Message-Id 衍生的 12 位 legacy 当作「另一封邮件已处理」的证据；
 * - `aliases` 仅用于 `--only-mail` 等「认领本邮件」的匹配，不得充当 processed 证据。
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

/** 一封邮件在运行期的全部已知身份（primary + 升级别名 + 证据键）。 */
export interface MailIdentity {
  /**
   * 新写入使用的规范身份：有 raw 时为 32 位内容绑定 hash；
   * 否则优先沿用缓存文件名上的合法 hash（保持 fetch 时身份）；再否则 legacy 12 位。
   */
  primary: string;
  /**
   * primary、legacy 12 位、缓存文件名等全部别名。
   * **仅**用于 `--only-mail` 等「认领本邮件」匹配；禁止整组写入 state，
   * 也禁止当作「另一封邮件已处理」的证据（CORE-03 / BLOCKING 10）。
   */
  aliases: readonly string[];
  /**
   * 足以证明「这一封邮件」已被处理/抓取的键集合。
   *
   * - 始终含 `primary`；
   * - 含与 primary 不同的合法 `fileHash`（缓存文件名即 fetch 时身份）；
   * - **仅当** primary 或 fileHash 本身就是 legacy 时才含 Message-Id 衍生的 12 位
   *   （说明本邮件的运营身份就是升级前的那条记录）；
   * - 内容绑定的 32 位身份 **绝不** 把「仅由 Message-Id 推出的 legacy」当作证据，
   *   否则两封共享 Message-Id 的不同邮件会互相折叠。
   */
  evidence: readonly string[];
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
 * `aliases` 始终收纳 legacy / fileHash / computed，便于 `--only-mail` 命中。
 * `evidence` 更严格：Message-Id 衍生 legacy 不能单独充当 processed 证据。
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

  // processed / fetched / in-flight / INDEX 去重：只认「这封邮件自己的」键。
  const evidence = new Set<string>();
  evidence.add(primary);
  if (fileHash) evidence.add(fileHash);
  // legacy 仅在它就是本邮件运营身份时才算证据（fileHash 或 primary 即 legacy）。
  // 内容绑定 32 位 primary 且缓存名也不是 legacy 时，不得用 Message-Id 折叠另一封邮件。
  if (primary === legacy || fileHash === legacy) {
    evidence.add(legacy);
  }

  return {
    primary,
    aliases: Object.freeze([...aliases]),
    evidence: Object.freeze([...evidence]),
    legacy,
  };
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

/**
 * state / 并发集命中：默认用 `evidence`（安全），避免 Message-Id legacy 折叠不同邮件。
 * 若调用方显式传入 aliases 集合则按传入集合匹配。
 */
export function identityInSet(identity: MailIdentity, set: { has(h: string): boolean }): boolean {
  if (set.has(identity.primary)) return true;
  for (const a of identity.evidence) {
    if (set.has(a)) return true;
  }
  return false;
}

/** Stable short fingerprint of a document's bytes, used to distinguish distinct
 *  documents in one email while still collapsing true reprocessing duplicates. */
export function contentHash(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex').slice(0, 12);
}
