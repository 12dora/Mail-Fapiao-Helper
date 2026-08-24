import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { migrateRawConfig, validateConfigCandidate } from '../config.js';
import { redactPath, sanitizeText } from './sanitize.js';
import { asObject } from './payload.js';
import { bundledConfigPath, configPath } from './runtime.js';

// ---------------------------------------------------------------------------
// 配置读写（APP-08 / 契约 4）
// ---------------------------------------------------------------------------

export interface SaveConfigPayload {
  imap?: {
    host?: string;
    port?: number | string;
    user?: string;
    pass?: string;
    tls?: boolean;
    mailbox?: string[];
  };
  filter?: {
    keywords?: string[];
    since?: string;
    until?: string;
    sinceDays?: number | string;
    matchSubject?: boolean;
    matchBody?: boolean;
  };
  paths?: {
    samples?: string;
    invoices?: string;
    pending?: string;
  };
  output?: {
    csv?: string;
  };
  rename?: {
    avoidConflictBeforeOcr?: boolean;
    rule?: string;
    fallback?: string;
    applyAfterOcr?: boolean;
    organizeByType?: boolean;
    typeDirRule?: string;
    organizedDir?: string;
  };
  ocr?: {
    enabled?: boolean;
    provider?: string;
    ocrMode?: string;
    executionMode?: string;
    serviceHost?: string;
    servicePort?: number | string;
    serviceWorkers?: number | string;
    batchSize?: number | string;
    resultsCsv?: string;
    credentials?: Record<string, string>;
  };
  playwright?: {
    headless?: boolean;
    timeoutMs?: number | string;
  };
  network?: {
    retries?: number | string;
    retryDelayMs?: number | string;
  };
}

export type ConfigRead =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; message: string };

/** 读取真实配置；损坏时如实报错，绝不静默替换成 example。 */
export function readConfigStrict(): ConfigRead {
  const source = fs.existsSync(configPath) ? configPath : bundledConfigPath;
  try {
    const parsed = JSON.parse(fs.readFileSync(source, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '配置文件内容不是一个 JSON 对象。' };
    }
    return { ok: true, raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: sanitizeText(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * 仅用于「解析目录位置」的宽松读取：目录创建、摘要刷新等只读路径在配置损坏时
 * 仍需要一组可用路径。任何写盘路径都不得使用它。
 */
export function readConfigForPaths(): Record<string, unknown> {
  const result = readConfigStrict();
  if (result.ok) return result.raw;
  try {
    return JSON.parse(fs.readFileSync(bundledConfigPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function mergeDefined(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const child = asObject(target[key]);
      target[key] = child;
      mergeDefined(child, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/** 展示脱敏串（含 <占位> / …/ 截断）不得回写磁盘；与 secret 留空不修改同理。 */
export function looksLikeRedactedPathDisplay(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.includes('<') || v.includes('>') || v.includes('\0')) return true;
  if (v.startsWith('…') || v.startsWith('...')) return true;
  return false;
}

/**
 * 从 save payload 去掉脱敏展示路径，避免 auto-save 把「已配置」串写回 config.json。
 * 真正改路径时 renderer 必须提交未脱敏的新值（用户重新输入或走目录选择器）。
 */
export function stripRedactedPathFields(patch: Record<string, unknown>): void {
  const scrubObj = (block: unknown, keys: string[]): void => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return;
    const obj = block as Record<string, unknown>;
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'string' && looksLikeRedactedPathDisplay(v)) {
        delete obj[key];
      }
    }
  };
  scrubObj(patch.paths, ['samples', 'invoices', 'pending']);
  scrubObj(patch.output, ['csv']);
  scrubObj(patch.rename, ['organizedDir']);
  scrubObj(patch.ocr, ['resultsCsv']);
}

export function normalizeSavePayload(value: unknown): Record<string, unknown> {
  const payload = asObject(value) as SaveConfigPayload;
  const ocrCredentials = {
    ...(payload.ocr?.credentials ?? {}),
  };
  const legacy = asObject(value);
  if (typeof legacy.tencentSecretId === 'string') ocrCredentials.tencentSecretId = legacy.tencentSecretId;
  if (typeof legacy.tencentSecretKey === 'string') ocrCredentials.tencentSecretKey = legacy.tencentSecretKey;
  if (typeof legacy.tencentRegion === 'string') ocrCredentials.tencentRegion = legacy.tencentRegion;
  const ocrProvider = typeof legacy.ocrVendor === 'string' ? legacy.ocrVendor : payload.ocr?.provider;

  const normalized: Record<string, unknown> = {
    imap: payload.imap,
    filter: payload.filter,
    paths: payload.paths,
    output: payload.output,
    rename: payload.rename,
    ocr: {
      ...payload.ocr,
      provider: ocrProvider === 'none' ? 'efapiao' : ocrProvider,
      enabled: ocrProvider === 'none' ? false : payload.ocr?.enabled,
      credentials: ocrCredentials,
    },
    playwright: payload.playwright,
    network: payload.network,
  };
  stripRedactedPathFields(normalized);
  return normalized;
}

export interface SaveConfigOutcome {
  ok: boolean;
  configPath: string;
  config?: Record<string, unknown>;
  fieldErrors?: { path: string; message: string }[];
  configError?: { message: string; detail?: string; backupPath?: string; backupCreated?: boolean };
  /** 显式修复损坏配置时，被隔离备份的旧文件（已脱敏）。 */
  repairedFrom?: string;
  /** COPY-02：旧配置是否成功另存为备份。 */
  backupCreated?: boolean;
  /** 备份路径（已脱敏）；仅 backupCreated 为 true 时有意义。 */
  backupPath?: string;
}

export function writeConfigAtomic(candidate: Record<string, unknown>): void {
  // Atomic tmp+rename so a crash mid-write can never leave a truncated
  // config.json (which holds the IMAP password) on disk.
  const tmpPath = `${configPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best-effort on platforms that do not preserve POSIX file modes.
  }
}

/**
 * 合并 → 用正式 schema 校验完整候选配置 → 原子替换。校验不通过时返回字段级错误，
 * 磁盘上的旧配置保持不变（APP-08）。
 */
export function saveConfig(
  payload: unknown,
  opts: { repairCorrupt?: boolean } = {},
  validateSavePathFields: (candidate: Record<string, unknown>) => { path: string; message: string }[],
): SaveConfigOutcome {
  let base: Record<string, unknown>;
  let backupPath: string | undefined;
  let backupCreated = false;
  const current = readConfigStrict();
  if (current.ok) {
    base = current.raw;
  } else if (!opts.repairCorrupt) {
    return {
      ok: false,
      configPath: redactPath(configPath),
      configError: { message: `配置文件已损坏，无法保存：${current.message}` },
    };
  } else {
    // 显式修复：先把损坏文件隔离备份，再以内置示例为基线重建。
    const backup = `${configPath}.corrupt-${Date.now()}.json`;
    try {
      if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, backup);
        backupPath = redactPath(backup);
        backupCreated = true;
      }
    } catch {
      backupPath = undefined;
      backupCreated = false;
    }
    try {
      base = JSON.parse(fs.readFileSync(bundledConfigPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        configPath: redactPath(configPath),
        configError: {
          message: '内置示例配置不可读，无法修复配置文件。',
          backupCreated,
          ...(backupPath ? { backupPath } : {}),
        },
        backupCreated,
        ...(backupPath ? { backupPath } : {}),
      };
    }
  }

  const merged = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mergeDefined(merged, normalizeSavePayload(payload));
  // 先迁移（补 schemaVersion 与新版默认值），再用正式 schema 校验完整候选配置。
  const candidate = migrateRawConfig(merged).raw;

  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) {
    return { ok: false, configPath: redactPath(configPath), fieldErrors: validated.errors };
  }

  // ELEC-06：配置路径在落盘前由主进程独立校验，拒绝系统目录/危险根及其子孙。
  const pathFieldErrors = validateSavePathFields(candidate);
  if (pathFieldErrors.length > 0) {
    return { ok: false, configPath: redactPath(configPath), fieldErrors: pathFieldErrors };
  }

  try {
    writeConfigAtomic(candidate);
  } catch (err) {
    return {
      ok: false,
      // ELEC-07：不向 renderer 泄漏原始 configPath。
      configPath: redactPath(configPath),
      configError: {
        // COPY-10：配置写失败不等于「数据目录」问题；指向可见的设置操作。
        message: '无法保存设置。请确认应用有写入权限后重试；若仍失败，请在「邮箱与保存」中检查保存位置。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
        backupCreated,
        ...(backupPath ? { backupPath } : {}),
      },
      backupCreated,
      ...(backupPath ? { backupPath } : {}),
    };
  }
  return {
    ok: true,
    configPath: redactPath(configPath),
    config: redactConfig(candidate),
    backupCreated,
    ...(backupPath ? { repairedFrom: backupPath, backupPath } : {}),
  };
}

/**
 * 屏蔽 secret 与绝对路径后再交给 renderer（ELEC-07 / S3）。
 *
 * 规则驱动（非字段白名单）：
 * - 字段名命中 secret/key/token/pass → 清空字符串
 * - 任意字符串若像绝对路径 / 盘符 / UNC → redactPath
 * - 递归处理嵌套对象与数组，新增路径字段默认脱敏，避免遗漏 ocr.binaryPath 等
 *
 * 相对路径保留（无用户名泄漏，配置表单可回显）。打开目录走 `mfh:open-path`
 * 的 `location` / opaque handle，renderer 不需要真路径。
 */
export function redactConfig(raw: Record<string, unknown>): Record<string, unknown> {
  /**
   * 字段名像凭据才清空。刻意不用裸 `/key/`，避免误伤 `keywords` 等业务字段；
   * 命中 secret/token/pass、*apiKey、*secretKey/Id、以及单独的 `key`/`pass`。
   */
  const isSecretKey = (k: string): boolean => {
    const n = k.toLowerCase();
    if (n === 'keywords' || n === 'keyword') return false;
    if (n === 'key' || n === 'pass' || n === 'password' || n === 'passwd' || n === 'token' || n === 'secret') {
      return true;
    }
    return /secret|token|password|passwd|credential|api[_-]?key|secret[_-]?key|secret[_-]?id/.test(n);
  };
  const looksLikeAbsolutePath = (value: string): boolean => (
    path.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('//')
  );

  const redactValue = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key && isSecretKey(key)) return '';
      if (value.length > 0 && looksLikeAbsolutePath(value)) return redactPath(value);
      return value;
    }
    if (Array.isArray(value)) {
      // 数组本身若挂在 secret 键下（少见），整组不回传
      if (key && isSecretKey(key)) return [];
      return value.map((item) => redactValue(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, k)]),
      );
    }
    return value;
  };

  // imap.pass 始终清空（即便字段名规则已覆盖，显式保证）
  const result = redactValue(raw) as Record<string, unknown>;
  const imap = asObject(result.imap);
  if (Object.keys(imap).length > 0) {
    result.imap = { ...imap, pass: '' };
  }
  return result;
}
