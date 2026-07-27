/**
 * 统一的票据身份键（APP-06A）。
 *
 * 归档目录里的 filename 是唯一的编号文件名，contentHash 是归档字节的指纹；
 * 只有 `hash + filename + contentHash` 一起使用，OCR runner、OCR 摘要、应用摘要
 * 和整理（rename）四处才会对同一份票据得到同一个键，也才不会把同一封邮件里两个
 * 同名（source 相同）的不同附件折叠成一条。
 *
 * 历史 CSV 里可能缺少 contentHash 列、甚至缺少 hash/source 列，所以除了精确键还有
 * 回退匹配。回退遵循两条硬规则，避免「为了兼容老数据而把不同票据合并」：
 *
 * 1. **只有缺少判别字段的一方才能参与回退。** 两条都带 contentHash 时永远只比精确
 *    键：contentHash 不同 = 不同票据，绝不合并。文件名回退同理，只在某一方缺少
 *    hash 时才允许。
 * 2. **回退必须唯一。** 同一个回退键被两条不同身份登记过就标记为歧义并整体作废，
 *    宁可各自独立成条，也不猜测归属。
 *
 * 另外每个规范键会记录首个「强身份」的 contentHash（claim）：老行被新行升级成强
 * 身份之后，第二个 contentHash 不同的新行不会再借这条老行的回退键挤进同一条记录，
 * 也就不会出现「历史 legacy 行吞掉后来的新行」。
 */

/** 字段缺失时的占位符，避免空段造成的意外碰撞。 */
const EMPTY = '-';
/** 键分隔符；源码里是转义写法，不会写入真实 NUL 字节。 */
const SEP = '\u0001';

export interface ArtifactIdentity {
  /** 邮件身份 hash（msgIdHash）。 */
  hash?: string;
  /** 归档后的唯一文件名。 */
  filename?: string;
  /** 原始来源名（附件名/链接文件名），仅在 filename 缺失时作为回退。 */
  source?: string;
  /** 归档字节的内容指纹（contentHash）。 */
  contentHash?: string;
}

function norm(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nameOf(id: ArtifactIdentity): string {
  // filename 优先：同一封邮件里两个附件可以同名（source 相同），
  // 只有归档后的编号文件名是唯一的。source 只在 filename 缺失时兜底。
  return norm(id.filename) || norm(id.source);
}

/** 票据的精确身份键：hash + filename(或 source) + contentHash。 */
export function artifactKey(id: ArtifactIdentity): string {
  return [norm(id.hash) || EMPTY, nameOf(id) || EMPTY, norm(id.contentHash) || EMPTY].join(SEP);
}

/** 一级回退键：hash + 文件名（丢掉 contentHash）。 */
function hashNameKey(id: ArtifactIdentity): string {
  return `${norm(id.hash) || EMPTY}${SEP}${nameOf(id) || EMPTY}`;
}

/** 二级回退键：只剩文件名。 */
function nameKey(id: ArtifactIdentity): string {
  return nameOf(id);
}

/** 回退别名表；值为 null 表示该键有歧义，整体作废。 */
type AliasMap = Map<string, string | null>;

function registerAlias(map: AliasMap, key: string, canonical: string): void {
  const current = map.get(key);
  if (current === undefined) map.set(key, canonical);
  else if (current !== canonical) map.set(key, null);
}

/**
 * 以票据身份为键的索引。登记时同时维护精确键与「按缺失字段分流」的回退键，
 * 因此老行（无 contentHash）与新行（有 contentHash）会合并成一条，
 * 而两条各自带有不同 contentHash 的强身份行永远保持独立。
 */
export class ArtifactIndex<T> {
  private readonly rows = new Map<string, T>();
  /** 精确键 → 规范键。 */
  private readonly exact = new Map<string, string>();
  /** hash+文件名回退，由**缺少** contentHash 的行登记。 */
  private readonly hashNameFromLegacy: AliasMap = new Map();
  /** hash+文件名回退，由**带有** contentHash 的行登记。 */
  private readonly hashNameFromStrong: AliasMap = new Map();
  /** 文件名回退，由**缺少** hash 的行登记。 */
  private readonly nameFromHashless: AliasMap = new Map();
  /** 文件名回退，由**带有** hash 的行登记。 */
  private readonly nameFromHashed: AliasMap = new Map();
  /** 规范键 → 首个强身份的 contentHash，用来拒绝第二个内容不同的行。 */
  private readonly claims = new Map<string, string>();

  /**
   * 解析身份对应的规范键。读写共用同一套规则：写入不会比查询更宽松，
   * 否则新行会顺着回退键被塞进别人的记录里。
   */
  private resolveKey(id: ArtifactIdentity): string | undefined {
    const exactHit = this.exact.get(artifactKey(id));
    if (exactHit !== undefined) return exactHit;

    const name = nameOf(id);
    if (!name) return undefined;
    const contentHash = norm(id.contentHash);
    const hash = norm(id.hash);

    // 一级回退：只有一方缺 contentHash 时才允许。
    // 自己带 contentHash → 只能匹配缺 contentHash 的老行；
    // 自己缺 contentHash → 只能匹配带 contentHash 的新行
    //（双方都缺的情况精确键已经覆盖，不需要回退）。
    const hashNameSource = contentHash ? this.hashNameFromLegacy : this.hashNameFromStrong;
    const hashNameHit = hashNameSource.get(hashNameKey(id));
    if (hashNameHit === null) return undefined; // 歧义：拒绝合并
    if (hashNameHit !== undefined) return this.acceptClaim(hashNameHit, contentHash);

    // 二级回退：只有一方缺 hash 时才允许（更老的结果行连 hash 列都没有）。
    const nameSource = hash ? this.nameFromHashless : this.nameFromHashed;
    const nameHit = nameSource.get(nameKey(id));
    if (nameHit === null) return undefined;
    if (nameHit !== undefined) return this.acceptClaim(nameHit, contentHash);

    return undefined;
  }

  /** 规范键已被另一个 contentHash 认领时，拒绝这次回退命中。 */
  private acceptClaim(canonical: string, contentHash: string): string | undefined {
    if (!contentHash) return canonical;
    const claimed = this.claims.get(canonical);
    return claimed === undefined || claimed === contentHash ? canonical : undefined;
  }

  has(id: ArtifactIdentity): boolean {
    return this.resolveKey(id) !== undefined;
  }

  get(id: ArtifactIdentity): T | undefined {
    const key = this.resolveKey(id);
    return key === undefined ? undefined : this.rows.get(key);
  }

  /** 写入；`shouldReplace` 返回 false 时保留已有值（例如保留 success 不被后续 error 覆盖）。 */
  set(id: ArtifactIdentity, value: T, shouldReplace: (existing: T, next: T) => boolean = () => true): void {
    const key = this.resolveKey(id) ?? artifactKey(id);
    const existing = this.rows.get(key);
    if (existing === undefined || shouldReplace(existing, value)) this.rows.set(key, value);

    const contentHash = norm(id.contentHash);
    const hash = norm(id.hash);
    // 老行升级为强身份后即被认领，后续 contentHash 不同的行只能另立一条。
    if (contentHash && !this.claims.has(key)) this.claims.set(key, contentHash);

    const exactKey = artifactKey(id);
    if (!this.exact.has(exactKey)) this.exact.set(exactKey, key);
    if (!nameOf(id)) return;
    registerAlias(contentHash ? this.hashNameFromStrong : this.hashNameFromLegacy, hashNameKey(id), key);
    registerAlias(hash ? this.nameFromHashed : this.nameFromHashless, nameKey(id), key);
  }

  values(): T[] {
    return Array.from(this.rows.values());
  }

  get size(): number {
    return this.rows.size;
  }
}
