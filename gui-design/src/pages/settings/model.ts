/**
 * 设置页的表单模型。
 *
 * 三件事：
 * 1. 把 `getConfig()` 的配置对象摊成表单值（密钥永远是空串，见下）；
 * 2. 把表单值和基线对比，只把**改过的字段**拼成嵌套的局部草稿交给 `saveConfig()`；
 * 3. 把 `fieldErrors` 里的 `a.b[0]` 路径翻译成 antd 的 NamePath。
 *
 * 为什么只提交改动：主进程回给渲染层的配置是脱敏过的——密钥被清空，绝对路径被
 * 换成展示串。整份回写会把展示串当成真路径写进 config.json，把已保存的密钥抹掉。
 */
import type { AppConfig, ConfigDraft, ConfigErrorInfo, ConfigPayload, SecretPresence } from '../../bridge/index.js';

export type TabKey = 'mail' | 'storage' | 'ocr' | 'about';

export const TAB_KEYS: readonly TabKey[] = ['mail', 'storage', 'ocr', 'about'];

export function asTabKey(sub: string): TabKey {
  return (TAB_KEYS as readonly string[]).includes(sub) ? (sub as TabKey) : 'mail';
}

// ---------------------------------------------------------------------------
// 字段清单
// ---------------------------------------------------------------------------

type LeafKind = 'text' | 'number' | 'bool' | 'list' | 'secret';

interface Leaf {
  path: string;
  kind: LeafKind;
  /** 表单里用秒、配置里用毫秒时填 1000。 */
  scale?: number;
  fallback?: unknown;
}

/** 表单绑定的全部配置字段。没列在这里的键，设置页不会读也不会写。 */
const LEAVES: readonly Leaf[] = [
  { path: 'imap.host', kind: 'text' },
  { path: 'imap.port', kind: 'number', fallback: 993 },
  { path: 'imap.user', kind: 'text' },
  { path: 'imap.pass', kind: 'secret' },
  { path: 'imap.tls', kind: 'bool', fallback: true },
  { path: 'imap.mailbox', kind: 'list' },

  { path: 'filter.keywords', kind: 'list' },
  { path: 'filter.matchSubject', kind: 'bool', fallback: true },
  { path: 'filter.matchBody', kind: 'bool', fallback: true },
  { path: 'filter.sinceDays', kind: 'number', fallback: 30 },

  { path: 'paths.samples', kind: 'text' },
  { path: 'paths.invoices', kind: 'text' },
  { path: 'paths.pending', kind: 'text' },
  { path: 'output.csv', kind: 'text' },

  { path: 'rename.rule', kind: 'text' },
  { path: 'rename.fallback', kind: 'text' },
  { path: 'rename.applyAfterOcr', kind: 'bool', fallback: false },
  { path: 'rename.organizeByType', kind: 'bool', fallback: false },
  { path: 'rename.typeDirRule', kind: 'text' },
  { path: 'rename.organizedDir', kind: 'text' },
  { path: 'rename.avoidConflictBeforeOcr', kind: 'bool', fallback: true },

  { path: 'ocr.enabled', kind: 'bool', fallback: true },
  { path: 'ocr.provider', kind: 'text', fallback: 'efapiao' },
  { path: 'ocr.ocrMode', kind: 'text', fallback: 'auto' },
  { path: 'ocr.executionMode', kind: 'text', fallback: 'auto' },
  { path: 'ocr.serviceUrl', kind: 'text' },
  { path: 'ocr.serviceHost', kind: 'text', fallback: '127.0.0.1' },
  { path: 'ocr.servicePort', kind: 'number', fallback: 8000 },
  { path: 'ocr.serviceWorkers', kind: 'number', fallback: 1 },
  { path: 'ocr.serviceStartupMs', kind: 'number', fallback: 30000, scale: 1000 },
  { path: 'ocr.batchSize', kind: 'number', fallback: 16 },
  { path: 'ocr.timeoutMs', kind: 'number', fallback: 120000, scale: 1000 },

  { path: 'ocr.credentials.ocrVendor', kind: 'text' },
  { path: 'ocr.credentials.apiKey', kind: 'secret' },
  { path: 'ocr.credentials.tencentSecretId', kind: 'secret' },
  { path: 'ocr.credentials.tencentSecretKey', kind: 'secret' },
  { path: 'ocr.credentials.tencentRegion', kind: 'text' },
  { path: 'ocr.credentials.cnocrModelProfile', kind: 'text' },
];

/** 密钥字段：回读永远是空串，留空表示「不修改已保存的值」。 */
export const SECRET_PATHS: readonly string[] = LEAVES.filter((l) => l.kind === 'secret').map((l) => l.path);

/** 每个密钥字段对应的「已保存」标记，没有对应标记的填 null。 */
export const SECRET_PRESENCE: Record<string, keyof SecretPresence | null> = {
  'imap.pass': 'imapPass',
  'ocr.credentials.apiKey': 'ocrApiKey',
  'ocr.credentials.tencentSecretId': 'tencentSecretId',
  'ocr.credentials.tencentSecretKey': 'tencentSecretKey',
};

const TAB_OF_PREFIX: [string, TabKey][] = [
  ['imap.', 'mail'],
  ['filter.', 'mail'],
  ['paths.', 'storage'],
  ['output.', 'storage'],
  ['rename.', 'storage'],
  ['ocr.', 'ocr'],
];

/** 字段错误落在哪个标签页，用来把用户带到出错的那一页。 */
export function tabOfPath(path: string): TabKey {
  for (const [prefix, tab] of TAB_OF_PREFIX) if (path.startsWith(prefix)) return tab;
  return 'mail';
}

// ---------------------------------------------------------------------------
// 路径读写
// ---------------------------------------------------------------------------

export type NamePath = (string | number)[];

/** `ocr.credentials.apiKey` / `filter.keywords[2]` → antd 的 NamePath。 */
export function toNamePath(path: string): NamePath {
  const out: NamePath = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      out.push(part);
      continue;
    }
    out.push(match[1] as string);
    for (const index of (match[2] ?? '').matchAll(/\[(\d+)\]/g)) out.push(Number(index[1]));
  }
  return out;
}

function readPath(root: unknown, name: NamePath): unknown {
  let cur: unknown = root;
  for (const key of name) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

function writePath(root: Record<string, unknown>, name: NamePath, value: unknown): void {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < name.length - 1; i++) {
    const key = String(name[i]);
    const next = cur[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[String(name[name.length - 1])] = value;
}

// ---------------------------------------------------------------------------
// 配置 ↔ 表单
// ---------------------------------------------------------------------------

export type SettingsValues = Record<string, unknown>;

function coerce(leaf: Leaf, raw: unknown): unknown {
  switch (leaf.kind) {
    case 'secret':
      // 回读永远为空：主进程只告诉我们「有没有值」，不回传明文。
      return '';
    case 'bool':
      return typeof raw === 'boolean' ? raw : (leaf.fallback ?? false);
    case 'list':
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      const value = Number.isFinite(n) && String(raw ?? '').trim() !== '' ? n : (leaf.fallback as number);
      return leaf.scale ? Math.round((value / leaf.scale) * 100) / 100 : value;
    }
    default:
      return typeof raw === 'string' ? raw : ((leaf.fallback as string) ?? '');
  }
}

/** 把配置对象摊成表单初值。 */
export function toFormValues(config: AppConfig | undefined): SettingsValues {
  const out: SettingsValues = {};
  for (const leaf of LEAVES) {
    const name = toNamePath(leaf.path);
    writePath(out, name, coerce(leaf, readPath(config, name)));
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

/**
 * 表单值与基线对比，产出嵌套的局部草稿。
 *
 * - 密钥留空 = 不改；只有用户真的输入了新值，或点了「清除」，才会出现在草稿里。
 * - 数值字段为空（用户清掉了输入框）时按未改处理，交给校验提示，不写 0。
 */
export function buildDraft(
  values: SettingsValues,
  baseline: SettingsValues,
  clearedSecrets: ReadonlySet<string>,
): ConfigDraft {
  const draft: Record<string, unknown> = {};
  for (const leaf of LEAVES) {
    const name = toNamePath(leaf.path);
    const next = readPath(values, name);

    if (leaf.kind === 'secret') {
      const typed = typeof next === 'string' ? next : '';
      if (typed) writePath(draft, name, typed);
      else if (clearedSecrets.has(leaf.path)) writePath(draft, name, '');
      continue;
    }

    if (leaf.kind === 'number') {
      if (next === null || next === undefined || next === '') continue;
      const n = Number(next);
      if (!Number.isFinite(n)) continue;
      const scaled = leaf.scale ? Math.round(n * leaf.scale) : n;
      const current = readPath(baseline, name);
      const currentScaled = leaf.scale ? Math.round(Number(current) * leaf.scale) : Number(current);
      if (scaled !== currentScaled) writePath(draft, name, scaled);
      continue;
    }

    if (!sameValue(next, readPath(baseline, name))) writePath(draft, name, next);
  }
  return draft;
}

/** 展示用：配置文件里已经填过的密钥数量，用来决定占位文案。 */
export function secretPlaceholder(path: string, secrets: SecretPresence | undefined, cleared: boolean): string {
  if (cleared) return '保存后清除已存的值';
  const key = SECRET_PRESENCE[path];
  if (key && secrets?.[key]) return '已保存，留空则不修改';
  return '留空则不填写';
}

/** `configError` 在不同通道里既可能是字符串也可能是对象，统一成一句话。 */
export function errorText(value: string | ConfigErrorInfo | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return [value.message, value.detail].filter((v): v is string => Boolean(v)).join(' ');
}

export type { ConfigPayload };
