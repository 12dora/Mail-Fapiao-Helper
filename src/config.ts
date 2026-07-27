import { readFileSync } from 'node:fs';
import { boundsAreOrdered, isValidDateBound } from './util/dateRange.js';

/**
 * 配置 schema 版本（APP-08）。
 * - 缺失 `schemaVersion` 的旧配置一律视为 v1，由 `migrateRawConfig()` 迁移到当前版本。
 * - v2：`llm`、`output.dir`、`output.pendingDir`、`output.csv` 在 JSON 文件里变为可选
 *   （缺失时补默认值），并新增 `network.timeoutMs`。
 */
export const CONFIG_SCHEMA_VERSION = 2;

export interface Config {
  /** 迁移后的 schema 版本，始终等于 CONFIG_SCHEMA_VERSION。 */
  schemaVersion: number;
  imap: {
    host: string;
    port: number;
    user: string;
    pass: string;
    tls: boolean;
    mailbox: string[];
  };
  filter: {
    keywords: string[];
    matchSubject: boolean;
    matchBody: boolean;
    sinceDays: number;
    since: string | undefined;
    until: string | undefined;
  };
  paths: {
    samples: string;
    invoices: string;
    pending: string;
  };
  output: {
    dir: string;
    pendingDir: string;
    csv: string;
  };
  rename: {
    avoidConflictBeforeOcr: boolean;
    rule: string;
    fallback: string;
    applyAfterOcr: boolean;
    organizeByType: boolean;
    typeDirRule: string;
    organizedDir: string;
  };
  ocr: {
    enabled: boolean;
    provider: string;
    binaryPath: string;
    ocrMode: 'auto' | 'disabled' | 'required';
    executionMode: 'auto' | 'serve' | 'cli';
    serviceUrl: string;
    serviceHost: string;
    servicePort: number;
    serviceWorkers: number;
    serviceStartupMs: number;
    batchSize: number;
    timeoutMs: number;
    resultsCsv: string;
    credentials: Record<string, string>;
  };
  llm: {
    enabled: boolean;
    provider: string;
    model: string;
    apiKey: string;
  };
  playwright: {
    headless: boolean;
    timeoutMs: number;
    /**
     * 兼容保留字段（APP-19）：应用**不会**自动准备/下载浏览器，网页自动下载始终
     * 依赖系统已安装的 Chrome / Edge。旧配置里的 `app-managed` 仍可读入，但不再
     * 表示任何「由应用准备」的承诺。
     */
    browserManagement: string;
  };
  network: {
    retries: number;
    retryDelayMs: number;
    /** 单次 HTTP 尝试的整体超时（毫秒），覆盖 header 与 body。 */
    timeoutMs: number;
  };
}

export interface ConfigFieldError {
  /** 形如 `ocr.servicePort` 的字段路径。 */
  path: string;
  /** 面向用户的中文说明，包含字段名与合法范围。 */
  message: string;
}

export type ValidateConfigResult =
  | { ok: true; config: Config }
  | { ok: false; errors: ConfigFieldError[] };

// ---------------------------------------------------------------------------
// 默认值（迁移与校验共用，保证「文件里可缺省」与「Config 对象里一定存在」一致）
// ---------------------------------------------------------------------------

const DEFAULTS = {
  outputCsv: './invoices.csv',
  outputDir: './invoices',
  outputPendingDir: './pending',
  ocrBinaryPath: 'auto',
  ocrServiceHost: '127.0.0.1',
  ocrServicePort: 8000,
  ocrServiceWorkers: 1,
  ocrServiceStartupMs: 30000,
  ocrBatchSize: 16,
  ocrTimeoutMs: 120000,
  ocrResultsCsv: './invoices/ocr/ocr-results.csv',
  renameTypeDirRule: '{documentType}',
  renameOrganizedDir: './invoices/organized',
  playwrightBrowserManagement: 'system',
  networkRetries: 3,
  networkRetryDelayMs: 1000,
  networkTimeoutMs: 30000,
} as const;

// ---------------------------------------------------------------------------
// 读取工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickPath(raw: unknown, path: string): unknown {
  let cur: unknown = raw;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

class ErrorCollector {
  readonly errors: ConfigFieldError[] = [];

  add(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }
}

interface NumberRule {
  /** 缺省值；不给表示该字段必填。 */
  fallback?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  /** 附加在错误信息末尾的中文单位说明，例如「毫秒」。 */
  unit?: string;
}

function rangeText(rule: NumberRule): string {
  const kind = rule.integer ? '整数' : '数字';
  const unit = rule.unit ? `，单位：${rule.unit}` : '';
  if (rule.min !== undefined && rule.max !== undefined) {
    return `合法范围：${rule.min}..${rule.max} 之间的${kind}${unit}`;
  }
  if (rule.min !== undefined) {
    return `合法范围：不小于 ${rule.min} 的${kind}${unit}`;
  }
  if (rule.max !== undefined) {
    return `合法范围：不大于 ${rule.max} 的${kind}${unit}`;
  }
  return `合法范围：任意有限${kind}${unit}`;
}

/**
 * 数字字段读取。GUI 会把表单值持久化成字符串，所以接受数字字符串；但空字符串
 * 必须报错而不是被 `Number('')` 变成 0（APP-08 的核心陷阱）。
 */
function readNumber(c: ErrorCollector, raw: unknown, path: string, rule: NumberRule): number {
  const value = pickPath(raw, path);
  const fallback = rule.fallback ?? 0;

  if (value === undefined || value === null) {
    if (rule.fallback === undefined) {
      c.add(path, `config.${path} 是必填项。${rangeText(rule)}`);
      return fallback;
    }
    return rule.fallback;
  }

  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    if (value.trim().length === 0) {
      c.add(path, `config.${path} 不能为空。${rangeText(rule)}`);
      return fallback;
    }
    n = Number(value);
  } else {
    c.add(path, `config.${path} 必须是数字。${rangeText(rule)}`);
    return fallback;
  }

  if (!Number.isFinite(n)) {
    c.add(path, `config.${path} 不是有效数字。${rangeText(rule)}`);
    return fallback;
  }
  if (rule.integer && !Number.isInteger(n)) {
    c.add(path, `config.${path} 必须是整数，当前值：${n}。${rangeText(rule)}`);
    return fallback;
  }
  if (rule.min !== undefined && n < rule.min) {
    c.add(path, `config.${path} 超出范围，当前值：${n}。${rangeText(rule)}`);
    return fallback;
  }
  if (rule.max !== undefined && n > rule.max) {
    c.add(path, `config.${path} 超出范围，当前值：${n}。${rangeText(rule)}`);
    return fallback;
  }
  return n;
}

interface StringRule {
  fallback?: string;
  /** 允许空字符串（例如尚未填写的邮箱凭据）。 */
  allowEmpty?: boolean;
  /** 追加的中文提示。 */
  hint?: string;
}

function readString(c: ErrorCollector, raw: unknown, path: string, rule: StringRule = {}): string {
  const value = pickPath(raw, path);
  const fallback = rule.fallback ?? '';
  if (value === undefined || value === null) {
    if (rule.fallback === undefined && !rule.allowEmpty) {
      c.add(path, `config.${path} 是必填项，且必须是非空字符串。${rule.hint ?? ''}`.trimEnd());
      return fallback;
    }
    return fallback;
  }
  if (typeof value !== 'string') {
    c.add(path, `config.${path} 必须是字符串。${rule.hint ?? ''}`.trimEnd());
    return fallback;
  }
  if (value.length === 0 && !rule.allowEmpty && rule.fallback === undefined) {
    c.add(path, `config.${path} 不能为空。${rule.hint ?? ''}`.trimEnd());
    return fallback;
  }
  if (value.length === 0 && rule.fallback !== undefined) return rule.fallback;
  return value;
}

function readBool(c: ErrorCollector, raw: unknown, path: string, fallback?: boolean): boolean {
  const value = pickPath(raw, path);
  if (value === undefined || value === null) {
    if (fallback === undefined) {
      c.add(path, `config.${path} 是必填项，合法值：true 或 false`);
      return false;
    }
    return fallback;
  }
  if (typeof value !== 'boolean') {
    c.add(path, `config.${path} 必须是布尔值，合法值：true 或 false`);
    return fallback ?? false;
  }
  return value;
}

function readStringArray(c: ErrorCollector, raw: unknown, path: string): string[] {
  const value = pickPath(raw, path);
  if (!Array.isArray(value) || value.length === 0) {
    c.add(path, `config.${path} 必须是至少包含一项的字符串数组`);
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string' || item.length === 0) {
      c.add(`${path}[${i}]`, `config.${path}[${i}] 必须是非空字符串`);
      continue;
    }
    out.push(item);
  }
  return out;
}

/** mailbox 允许字符串或字符串数组；空数组表示「遍历全部文件夹」。 */
function readMailboxList(c: ErrorCollector, raw: unknown, path: string): string[] {
  const value = pickPath(raw, path);
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) {
    c.add(path, `config.${path} 必须是字符串或字符串数组（空数组表示遍历全部文件夹）`);
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string' || item.length === 0) {
      c.add(`${path}[${i}]`, `config.${path}[${i}] 必须是非空字符串`);
      continue;
    }
    out.push(item);
  }
  return out;
}

function readEnum<T extends string>(
  c: ErrorCollector,
  raw: unknown,
  path: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = pickPath(raw, path);
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  c.add(path, `config.${path} 只能是 ${allowed.join(' / ')} 之一`);
  return fallback;
}

function readDateBound(c: ErrorCollector, raw: unknown, path: string): string | undefined {
  const value = pickPath(raw, path);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    c.add(path, `config.${path} 必须是日期字符串（YYYY-MM-DD 或完整 ISO 8601 时间戳）`);
    return undefined;
  }
  if (!isValidDateBound(value)) {
    c.add(path, `config.${path}="${value}" 不是可解析的日期（YYYY-MM-DD 或完整 ISO 8601 时间戳）`);
    return undefined;
  }
  return value;
}

function readCredentials(c: ErrorCollector, raw: unknown, path: string): Record<string, string> {
  const value = pickPath(raw, path);
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    c.add(path, `config.${path} 必须是「键: 字符串」形式的对象`);
    return {};
  }
  return value as Record<string, string>;
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

export interface MigrateResult {
  /** 迁移后的原始对象（已补齐可选字段），不会修改调用方传入的对象。 */
  raw: Record<string, unknown>;
  /** 原始文件声明的版本；缺失视为 1。 */
  fromVersion: number;
  toVersion: number;
  migrated: boolean;
}

function cloneRaw(raw: unknown): Record<string, unknown> {
  const src = asRecord(raw);
  const out: Record<string, unknown> = { ...src };
  for (const [key, value] of Object.entries(src)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...(value as Record<string, unknown>) };
    }
  }
  return out;
}

function fillMissing(target: Record<string, unknown>, key: string, value: unknown): void {
  if (target[key] === undefined || target[key] === null) target[key] = value;
}

/**
 * 把任意历史版本的配置对象迁移到当前 schema。缺失 `schemaVersion` 视为 v1。
 * 迁移只补齐缺失字段，绝不覆盖用户已经写入的值。
 */
export function migrateRawConfig(raw: unknown): MigrateResult {
  const out = cloneRaw(raw);
  const declared = typeof out.schemaVersion === 'number' && Number.isFinite(out.schemaVersion)
    ? out.schemaVersion
    : 1;

  // v1 -> v2：output/llm/network.timeoutMs 允许缺省，这里补默认值。
  const paths = asRecord(out.paths);
  const output = { ...asRecord(out.output) };
  fillMissing(output, 'dir', typeof paths.invoices === 'string' && paths.invoices.length > 0
    ? paths.invoices
    : DEFAULTS.outputDir);
  fillMissing(output, 'pendingDir', typeof paths.pending === 'string' && paths.pending.length > 0
    ? paths.pending
    : DEFAULTS.outputPendingDir);
  fillMissing(output, 'csv', DEFAULTS.outputCsv);
  out.output = output;

  const llm = { ...asRecord(out.llm) };
  fillMissing(llm, 'enabled', false);
  fillMissing(llm, 'provider', '');
  fillMissing(llm, 'model', '');
  fillMissing(llm, 'apiKey', '');
  out.llm = llm;

  const network = { ...asRecord(out.network) };
  fillMissing(network, 'timeoutMs', DEFAULTS.networkTimeoutMs);
  out.network = network;

  out.schemaVersion = CONFIG_SCHEMA_VERSION;
  return {
    raw: out,
    fromVersion: declared,
    toVersion: CONFIG_SCHEMA_VERSION,
    migrated: declared !== CONFIG_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 共享校验器（APP-08 契约 1）：先迁移，再一次性收集**全部**字段错误。
 * `loadConfig()` 与 GUI 保存前的校验都必须复用它，避免两套契约互相矛盾。
 */
export function validateConfigCandidate(raw: unknown): ValidateConfigResult {
  const c = new ErrorCollector();

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: '', message: '配置必须是一个 JSON 对象' }] };
  }

  const migrated = migrateRawConfig(raw).raw;

  const config: Config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    imap: {
      // 首次安装时凭据为空字符串（COPY-03），空值代表「尚未配置」而不是配置损坏；
      // 真正的可用性检查在抓取入口做，并给出明确的中文提示。
      host: readString(c, migrated, 'imap.host', { allowEmpty: true, fallback: '' }),
      port: readNumber(c, migrated, 'imap.port', { min: 1, max: 65535, integer: true, fallback: 993 }),
      user: readString(c, migrated, 'imap.user', { allowEmpty: true, fallback: '' }),
      pass: readString(c, migrated, 'imap.pass', { allowEmpty: true, fallback: '' }),
      tls: readBool(c, migrated, 'imap.tls', true),
      mailbox: readMailboxList(c, migrated, 'imap.mailbox'),
    },
    filter: {
      keywords: readStringArray(c, migrated, 'filter.keywords'),
      matchSubject: readBool(c, migrated, 'filter.matchSubject'),
      matchBody: readBool(c, migrated, 'filter.matchBody'),
      sinceDays: readNumber(c, migrated, 'filter.sinceDays', { min: 1, unit: '天' }),
      since: readDateBound(c, migrated, 'filter.since'),
      until: readDateBound(c, migrated, 'filter.until'),
    },
    paths: {
      samples: readString(c, migrated, 'paths.samples'),
      invoices: readString(c, migrated, 'paths.invoices'),
      pending: readString(c, migrated, 'paths.pending'),
    },
    output: {
      dir: readString(c, migrated, 'output.dir', { fallback: DEFAULTS.outputDir }),
      pendingDir: readString(c, migrated, 'output.pendingDir', { fallback: DEFAULTS.outputPendingDir }),
      csv: readString(c, migrated, 'output.csv', { fallback: DEFAULTS.outputCsv }),
    },
    rename: {
      avoidConflictBeforeOcr: readBool(c, migrated, 'rename.avoidConflictBeforeOcr', true),
      rule: readString(c, migrated, 'rename.rule'),
      fallback: readString(c, migrated, 'rename.fallback'),
      applyAfterOcr: readBool(c, migrated, 'rename.applyAfterOcr', false),
      organizeByType: readBool(c, migrated, 'rename.organizeByType', false),
      typeDirRule: readString(c, migrated, 'rename.typeDirRule', { fallback: DEFAULTS.renameTypeDirRule }),
      organizedDir: readString(c, migrated, 'rename.organizedDir', { fallback: DEFAULTS.renameOrganizedDir }),
    },
    ocr: {
      enabled: readBool(c, migrated, 'ocr.enabled'),
      provider: readString(c, migrated, 'ocr.provider'),
      binaryPath: readString(c, migrated, 'ocr.binaryPath', { fallback: DEFAULTS.ocrBinaryPath }),
      ocrMode: readEnum(c, migrated, 'ocr.ocrMode', ['auto', 'disabled', 'required'] as const, 'auto'),
      executionMode: readEnum(c, migrated, 'ocr.executionMode', ['auto', 'serve', 'cli'] as const, 'auto'),
      // 默认空串，让 serviceHost/servicePort 保持权威；只有非空 serviceUrl 才表示
      // 指向一个外部托管的 OCR 服务。
      serviceUrl: readString(c, migrated, 'ocr.serviceUrl', { allowEmpty: true, fallback: '' }).replace(/\/+$/, ''),
      serviceHost: readString(c, migrated, 'ocr.serviceHost', { fallback: DEFAULTS.ocrServiceHost }),
      servicePort: readNumber(c, migrated, 'ocr.servicePort', {
        min: 1, max: 65535, integer: true, fallback: DEFAULTS.ocrServicePort,
      }),
      serviceWorkers: readNumber(c, migrated, 'ocr.serviceWorkers', {
        min: 1, integer: true, fallback: DEFAULTS.ocrServiceWorkers,
      }),
      serviceStartupMs: readNumber(c, migrated, 'ocr.serviceStartupMs', {
        min: 1, unit: '毫秒', fallback: DEFAULTS.ocrServiceStartupMs,
      }),
      batchSize: readNumber(c, migrated, 'ocr.batchSize', {
        min: 1, integer: true, fallback: DEFAULTS.ocrBatchSize,
      }),
      timeoutMs: readNumber(c, migrated, 'ocr.timeoutMs', {
        min: 1, unit: '毫秒', fallback: DEFAULTS.ocrTimeoutMs,
      }),
      resultsCsv: readString(c, migrated, 'ocr.resultsCsv', { fallback: DEFAULTS.ocrResultsCsv }),
      credentials: readCredentials(c, migrated, 'ocr.credentials'),
    },
    llm: {
      // 未发布的 LLM scaffold（CODE-08）：文件里整块可缺省，但 Config 对象里始终存在。
      enabled: readBool(c, migrated, 'llm.enabled', false),
      provider: readString(c, migrated, 'llm.provider', { allowEmpty: true, fallback: '' }),
      model: readString(c, migrated, 'llm.model', { allowEmpty: true, fallback: '' }),
      apiKey: readString(c, migrated, 'llm.apiKey', { allowEmpty: true, fallback: '' }),
    },
    playwright: {
      headless: readBool(c, migrated, 'playwright.headless', true),
      timeoutMs: readNumber(c, migrated, 'playwright.timeoutMs', { min: 1, unit: '毫秒', fallback: 30000 }),
      browserManagement: readString(c, migrated, 'playwright.browserManagement', {
        fallback: DEFAULTS.playwrightBrowserManagement,
      }),
    },
    network: {
      retries: readNumber(c, migrated, 'network.retries', {
        min: 0, integer: true, fallback: DEFAULTS.networkRetries,
      }),
      retryDelayMs: readNumber(c, migrated, 'network.retryDelayMs', {
        min: 0, unit: '毫秒', fallback: DEFAULTS.networkRetryDelayMs,
      }),
      timeoutMs: readNumber(c, migrated, 'network.timeoutMs', {
        min: 1, unit: '毫秒', fallback: DEFAULTS.networkTimeoutMs,
      }),
    },
  };

  // 跨字段约束
  if (config.filter.matchSubject === false && config.filter.matchBody === false) {
    c.add('filter.matchSubject', 'config.filter：matchSubject 与 matchBody 至少要有一个为 true');
  }
  if (config.filter.since && config.filter.until && !boundsAreOrdered(config.filter.since, config.filter.until)) {
    c.add('filter.until', `config.filter.since（${config.filter.since}）必须早于或等于 config.filter.until（${config.filter.until}）`);
  }
  if (config.llm.enabled) {
    c.add('llm.enabled', 'config.llm.enabled=true 在当前版本中不受支持，请设置为 false');
  }

  if (!c.ok) return { ok: false, errors: c.errors };
  return { ok: true, config };
}

/** 把字段错误拼成一条可读的中文错误信息。 */
export function formatConfigErrors(errors: ConfigFieldError[]): string {
  return errors.map((e) => `- ${e.message}`).join('\n');
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`无法读取配置文件 ${path}：${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${(e as Error).message}`);
  }

  const result = validateConfigCandidate(raw);
  if (!result.ok) {
    throw new Error(`配置文件 ${path} 校验失败：\n${formatConfigErrors(result.errors)}`);
  }
  return result.config;
}
