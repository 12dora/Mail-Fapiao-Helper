import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PathPolicyDependencies {
  dataDir: string;
  asObject(value: unknown): Record<string, unknown>;
  invoicesDirPath(): string;
  pendingDirPath(): string;
  samplesDirPath(): string;
  resolvedPath(section: 'paths' | 'ocr' | 'rename' | 'output', key: string, fallback: string): string;
  ledgerCsvPath(): string;
}

export type OpenLocationKey = 'invoices' | 'pending' | 'samples' | 'organized' | 'dataDir' | 'ledger';

export function createPathPolicy(deps: PathPolicyDependencies) {
  const { dataDir, asObject, invoicesDirPath, pendingDirPath, samplesDirPath, resolvedPath, ledgerCsvPath } = deps;
// ---------------------------------------------------------------------------
// 路径规范化与删除/打开 containment（ELEC-01 / ELEC-06）
// ---------------------------------------------------------------------------

/**
 * 解析路径的真实位置：存在则 realpath；不存在则 realpath 最近已存在祖先再拼后缀。
 * 任一环节失败返回 undefined（调用方必须 fail closed）。
 */
function resolveCanonicalPath(target: string): string | undefined {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync(abs);
  } catch {
    // 目标不存在：向上找最近存在的祖先并 realpath。
    let cur = path.dirname(abs);
    const parts: string[] = [path.basename(abs)];
    while (true) {
      try {
        const realAncestor = fs.realpathSync(cur);
        return path.join(realAncestor, ...parts.reverse());
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return undefined;
        parts.push(path.basename(cur));
        cur = parent;
      }
    }
  }
}

/** 数据目录的 realpath；失败则 undefined（fail closed）。 */
function realDataDir(): string | undefined {
  try {
    return fs.realpathSync(dataDir);
  } catch {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      return fs.realpathSync(dataDir);
    } catch {
      return undefined;
    }
  }
}

/**
 * 双方已 canonical 的路径段 containment 比较。
 * 用「根 + 分隔符」前缀，避免 `/a/bc` 被当成 `/a/b` 的子路径；
 * 也避免 `path.relative` 对 `..hidden` 这类段名误判。
 * 任一侧为空则 false（fail closed）。
 */
function isPathSegmentInside(candidateCanon: string, rootCanon: string): boolean {
  if (!candidateCanon || !rootCanon) return false;
  const root = path.normalize(rootCanon);
  const cand = path.normalize(candidateCanon);
  if (process.platform === 'win32') {
    const rootLower = root.toLowerCase();
    const candLower = cand.toLowerCase();
    if (candLower === rootLower) return true;
    const prefix = rootLower.endsWith(path.sep) ? rootLower : rootLower + path.sep;
    return candLower.startsWith(prefix);
  }
  if (cand === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return cand.startsWith(prefix);
}

/**
 * 判断 candidate 是否 canonically 位于 root 内部。
 * 双方都用同一套 resolveCanonicalPath（realpath / 最近已存在祖先）；
 * 规范化失败一律 false（fail closed）。macOS 上 `/var`→`/private/var` 两侧对称。
 */
function isCanonicallyInside(candidate: string, root: string): boolean {
  const realRoot = resolveCanonicalPath(root);
  const realCandidate = resolveCanonicalPath(candidate);
  if (!realRoot || !realCandidate) return false;
  return isPathSegmentInside(realCandidate, realRoot);
}

/** 规范化后的系统危险根（用于 equal + descendant 拒绝）。 */
function dangerousSystemRoots(): string[] {
  const roots: string[] = [];
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    try {
      roots.push(path.normalize(fs.realpathSync(path.resolve(raw))));
    } catch {
      try {
        roots.push(path.normalize(path.resolve(raw)));
      } catch {
        // skip unresolvable
      }
    }
  };

  if (process.platform === 'win32') {
    push(process.env.SystemRoot || process.env.windir || 'C:\\Windows');
    push(process.env.ProgramFiles || 'C:\\Program Files');
    push(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
    push(process.env.ProgramData || 'C:\\ProgramData');
    push(process.env.SystemDrive ? `${process.env.SystemDrive}\\Windows` : 'C:\\Windows');
  } else {
    for (const p of [
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/System',
      '/Applications',
      '/Library',
      '/private/etc',
      '/private/var/root',
      '/dev',
      '/proc',
      '/sys',
      '/var/root',
      '/boot',
      '/root',
    ]) {
      push(p);
    }
  }
  return roots;
}

/**
 * 不得作为 open-path 允许根 / 配置保存路径的危险位置（含系统根及其子孙）。
 * 家目录的子目录可以（用户常把发票放在 ~/Documents/...）；裸家目录本身不行。
 */
function isDangerousOpenRoot(canonPath: string): boolean {
  if (!canonPath) return true;
  const normalized = path.normalize(canonPath);
  const fsRoot = path.parse(normalized).root;
  // 文件系统根（`/` 或 `C:\`）
  if (!fsRoot || normalized === fsRoot || normalized === path.sep) return true;

  for (const blocked of dangerousSystemRoots()) {
    if (isPathSegmentInside(normalized, blocked)) return true;
  }

  try {
    const home = fs.realpathSync(os.homedir());
    if (process.platform === 'win32') {
      if (normalized.toLowerCase() === home.toLowerCase()) return true;
    } else if (normalized === home) {
      return true;
    }
  } catch {
    // homedir 解析失败时不因此放行危险根
  }
  return false;
}

/**
 * 配置路径是否「像用户文档位置」：相对路径、数据目录内、用户主目录下的子路径、
 * 或非系统盘符/卷上的非根目录。系统目录及其子孙一律否。
 */
function isPlausibleUserDocumentLocation(canonPath: string): boolean {
  if (!canonPath || isDangerousOpenRoot(canonPath)) return false;
  const data = realDataDir();
  if (data && isPathSegmentInside(canonPath, data)) return true;
  try {
    const home = fs.realpathSync(os.homedir());
    // 允许家目录下的子路径，不允许裸家目录（isDangerousOpenRoot 已拦）
    if (isPathSegmentInside(canonPath, home)) return true;
  } catch {
    // continue
  }
  // 外置盘 / 其他卷：至少比盘符根深一层，且已通过系统 deny-list
  const fsRoot = path.parse(canonPath).root;
  if (fsRoot && isPathSegmentInside(canonPath, fsRoot)) {
    const rel = path.relative(fsRoot, canonPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).filter(Boolean).length >= 1) {
      return true;
    }
  }
  // UNC：\\server\share\... 至少到 share 下一级更安全，但仍允许 share 根作文档库
  if (canonPath.startsWith('\\\\') || canonPath.startsWith('//')) {
    const parts = canonPath.replace(/^[\\/]+/, '').split(/[\\/]/).filter(Boolean);
    return parts.length >= 2;
  }
  return false;
}

/**
 * 校验 renderer 拟写入配置的路径字段。失败返回中文错误；通过返回 undefined。
 * 相对路径锚定 dataDir 后再做危险/可信位置检查。
 */
function validateConfiguredPathValue(raw: string, fieldPath: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // 脱敏展示串不得回写（含 <…> 占位与省略号路径）
  if (trimmed.includes('<') || trimmed.includes('>') || trimmed.startsWith('…') || trimmed.includes('\0')) {
    return `${fieldPath}：路径无效或为展示占位，请填写真实保存位置。`;
  }
  const abs = path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('//')
    ? path.resolve(trimmed)
    : path.resolve(dataDir, trimmed);
  const canon = resolveCanonicalPath(abs);
  if (!canon) {
    return `${fieldPath}：无法确认路径位置，已拒绝保存。`;
  }
  if (isDangerousOpenRoot(canon) || !isPlausibleUserDocumentLocation(canon)) {
    return `${fieldPath}：不能使用系统目录或不可信位置，请选择用户文档类文件夹。`;
  }
  return undefined;
}

/** 在落盘前校验 paths.* / output.csv / rename.organizedDir / ocr.resultsCsv。 */
function validateSavePathFields(candidate: Record<string, unknown>): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const check = (value: unknown, field: string): void => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const msg = validateConfiguredPathValue(value, field);
    if (msg) errors.push({ path: field, message: msg });
  };
  const paths = asObject(candidate.paths);
  check(paths.samples, 'paths.samples');
  check(paths.invoices, 'paths.invoices');
  check(paths.pending, 'paths.pending');
  const output = asObject(candidate.output);
  check(output.csv, 'output.csv');
  const rename = asObject(candidate.rename);
  check(rename.organizedDir, 'rename.organizedDir');
  const ocr = asObject(candidate.ocr);
  check(ocr.resultsCsv, 'ocr.resultsCsv');
  return errors;
}

/**
 * ELEC-06：open-path 允许根仅由主进程从磁盘配置自行计算，绝不读 IPC payload。
 * = canonical dataDir + 配置的 invoices/pending/samples + organizedDir + 输出 CSV 父目录。
 * 规范化失败的根跳过；危险根（系统目录及其子孙 / 裸家目录）跳过。
 */
function openPathAllowedRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const canon = resolveCanonicalPath(raw);
    if (!canon) return;
    if (isDangerousOpenRoot(canon) || !isPlausibleUserDocumentLocation(canon)) return;
    const key = process.platform === 'win32' ? canon.toLowerCase() : canon;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(canon);
  };

  add(realDataDir());
  add(invoicesDirPath());
  add(pendingDirPath());
  add(samplesDirPath());
  try {
    add(resolvedPath('rename', 'organizedDir', './invoices/organized'));
  } catch {
    // organized 路径解析失败则跳过
  }
  // 输出台账 CSV 的父目录（用户可能把它放到归档目录之外）
  try {
    add(path.dirname(ledgerCsvPath()));
  } catch {
    // ledger 路径解析失败则跳过
  }
  return roots;
}

/** 目标是否落在当前 open-path 允许根内（fail closed）。 */
function isInsideOpenPathAllowedRoots(canonPath: string): boolean {
  if (!canonPath) return false;
  for (const root of openPathAllowedRoots()) {
    if (isPathSegmentInside(canonPath, root)) return true;
  }
  return false;
}

/** 主进程已知的符号位置 → 绝对路径（仅 main 解析，renderer 不得伪造）。 */
function resolveSymbolicLocation(location: string): string | undefined {
  switch (location) {
    case 'invoices':
      return invoicesDirPath();
    case 'pending':
      return pendingDirPath();
    case 'samples':
      return samplesDirPath();
    case 'organized':
      return resolvedPath('rename', 'organizedDir', './invoices/organized');
    case 'dataDir':
      return dataDir;
    case 'ledger':
      return path.dirname(ledgerCsvPath());
    default:
      return undefined;
  }
}

/**
 * 删除前的 containment 检查：目标及其最近祖先都必须落在真实数据目录内。
 * 中间若有指向外部的 symlink/junction，realpath 会逃出，检查失败。
 */
function assertSafeToDeleteInsideDataDir(target: string): string | undefined {
  const base = realDataDir();
  if (!base) return undefined;
  if (!isCanonicallyInside(target, base)) return undefined;
  // 再校验最近已存在祖先也在数据目录内（防止删除时路径段穿越）。
  let cur = path.resolve(target);
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      if (!isCanonicallyInside(real, base)) return undefined;
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return undefined;
      cur = parent;
    }
  }
  return resolveCanonicalPath(target);
}

  return {
    resolveCanonicalPath,
    realDataDir,
    isPathSegmentInside,
    isCanonicallyInside,
    dangerousSystemRoots,
    isDangerousOpenRoot,
    isPlausibleUserDocumentLocation,
    validateConfiguredPathValue,
    validateSavePathFields,
    openPathAllowedRoots,
    isInsideOpenPathAllowedRoots,
    resolveSymbolicLocation,
    assertSafeToDeleteInsideDataDir,
  };
}
