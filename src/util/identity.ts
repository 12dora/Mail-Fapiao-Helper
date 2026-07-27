/**
 * 统一的票据身份键（APP-06A）。
 *
 * 归档目录里的 filename 是唯一的编号文件名，contentHash 是归档字节的指纹；
 * 只有 `hash + filename + contentHash` 一起使用，OCR runner、OCR 摘要、应用摘要
 * 和整理（rename）四处才会对同一份票据得到同一个键，也才不会把同一封邮件里两个
 * 同名（source 相同）的不同附件折叠成一条。
 *
 * 历史 CSV 里可能缺少 contentHash 列、甚至缺少 hash/source 列，因此除了精确键，
 * 这里还给出有序的回退键：查找时从精确到宽松逐个尝试，老数据不会整体失效。
 */

/** 字段缺失时的占位符，避免 `a\0\0b` 这类空段造成的意外碰撞。 */
const EMPTY = '-';

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
  return [norm(id.hash) || EMPTY, nameOf(id) || EMPTY, norm(id.contentHash) || EMPTY].join('\0');
}

/**
 * 精确键加老数据回退键（有序，先精确后宽松），用于索引登记与查找。
 * 回退项只放宽 contentHash，不放宽文件名，避免重新引入 APP-06A 的折叠问题。
 */
export function artifactKeyCandidates(id: ArtifactIdentity): string[] {
  const hash = norm(id.hash) || EMPTY;
  const name = nameOf(id) || EMPTY;
  const keys = [artifactKey(id)];
  // 迁移兼容：老的 result/pending 行没有 contentHash 列。
  const withoutContentHash = `${hash}\0${name}\0${EMPTY}`;
  if (!keys.includes(withoutContentHash)) keys.push(withoutContentHash);
  return keys;
}

/**
 * 只用于查找的宽松键：更老的 result 行既没有 hash 也没有 source，只剩 filename。
 * 这类键可能被多个身份登记，因此在索引里会被标记为不可用（见 ArtifactIndex）。
 */
export function artifactWeakKeys(id: ArtifactIdentity): string[] {
  const name = nameOf(id);
  return name ? [`${EMPTY}\0${name}\0${EMPTY}`] : [];
}

/**
 * 以票据身份为键的索引：登记时把精确键和回退键都指向同一条规范键，
 * 因此「老行（无 contentHash）」与「新行（有 contentHash）」会合并成一条，
 * 而不是变成两条重复记录。
 */
export class ArtifactIndex<T> {
  private readonly rows = new Map<string, T>();
  private readonly aliases = new Map<string, string>();
  /** 宽松别名；被两个不同身份登记过的键置为 null，宁可查不到也不错配。 */
  private readonly weakAliases = new Map<string, string | null>();

  private resolveStrongKey(id: ArtifactIdentity): string | undefined {
    for (const key of artifactKeyCandidates(id)) {
      const hit = this.aliases.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private resolveKey(id: ArtifactIdentity): string | undefined {
    const strong = this.resolveStrongKey(id);
    if (strong !== undefined) return strong;
    for (const key of artifactWeakKeys(id)) {
      const hit = this.weakAliases.get(key);
      if (hit) return hit;
    }
    return undefined;
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
    // 写入只认精确/回退键，不认宽松键：否则两封不同邮件里同名的文件会被合并。
    const key = this.resolveStrongKey(id) ?? artifactKey(id);
    const existing = this.rows.get(key);
    if (existing === undefined || shouldReplace(existing, value)) this.rows.set(key, value);
    for (const alias of artifactKeyCandidates(id)) {
      if (!this.aliases.has(alias)) this.aliases.set(alias, key);
    }
    for (const alias of artifactWeakKeys(id)) {
      const current = this.weakAliases.get(alias);
      if (current === undefined) this.weakAliases.set(alias, key);
      else if (current !== key) this.weakAliases.set(alias, null);
    }
  }

  values(): T[] {
    return Array.from(this.rows.values());
  }

  get size(): number {
    return this.rows.size;
  }
}
