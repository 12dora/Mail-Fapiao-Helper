import { readFileSync } from 'node:fs';

export interface Config {
  imap: {
    host: string;
    port: number;
    user: string;
    pass: string;
    tls: boolean;
    mailbox: string;
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
    rule: string;
    fallback: string;
  };
  ocr: {
    enabled: boolean;
    provider: string;
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
  };
  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

function requireField(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in (cur as Record<string, unknown>))) {
      throw new Error(`config.${path} is required`);
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`config.${path} must be a non-empty string`);
  }
  return v;
}

function asNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`config.${path} must be a finite number`);
  }
  return v;
}

function asBool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') {
    throw new Error(`config.${path} must be a boolean`);
  }
  return v;
}

function optDateString(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') {
    throw new Error(`config.${path} must be a date string (YYYY-MM-DD or ISO 8601)`);
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) {
    throw new Error(`config.${path}="${v}" is not a parseable date`);
  }
  return v;
}

function asStringArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`config.${path} must be a non-empty array of strings`);
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || v[i].length === 0) {
      throw new Error(`config.${path}[${i}] must be a non-empty string`);
    }
  }
  return v as string[];
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`failed to read config at ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`config at ${path} is not valid JSON: ${(e as Error).message}`);
  }

  const cfg: Config = {
    imap: {
      host: asString(requireField(raw, 'imap.host'), 'imap.host'),
      port: asNumber(requireField(raw, 'imap.port'), 'imap.port'),
      user: asString(requireField(raw, 'imap.user'), 'imap.user'),
      pass: asString(requireField(raw, 'imap.pass'), 'imap.pass'),
      tls: asBool(requireField(raw, 'imap.tls'), 'imap.tls'),
      mailbox: asString(requireField(raw, 'imap.mailbox'), 'imap.mailbox'),
    },
    filter: {
      keywords: asStringArray(requireField(raw, 'filter.keywords'), 'filter.keywords'),
      matchSubject: asBool(requireField(raw, 'filter.matchSubject'), 'filter.matchSubject'),
      matchBody: asBool(requireField(raw, 'filter.matchBody'), 'filter.matchBody'),
      sinceDays: asNumber(requireField(raw, 'filter.sinceDays'), 'filter.sinceDays'),
      since: optDateString((raw as { filter?: { since?: unknown } }).filter?.since, 'filter.since'),
      until: optDateString((raw as { filter?: { until?: unknown } }).filter?.until, 'filter.until'),
    },
    paths: {
      samples: asString(requireField(raw, 'paths.samples'), 'paths.samples'),
      invoices: asString(requireField(raw, 'paths.invoices'), 'paths.invoices'),
      pending: asString(requireField(raw, 'paths.pending'), 'paths.pending'),
    },
    output: {
      dir: asString(requireField(raw, 'output.dir'), 'output.dir'),
      pendingDir: asString(requireField(raw, 'output.pendingDir'), 'output.pendingDir'),
      csv: asString(requireField(raw, 'output.csv'), 'output.csv'),
    },
    rename: {
      rule: asString(requireField(raw, 'rename.rule'), 'rename.rule'),
      fallback: asString(requireField(raw, 'rename.fallback'), 'rename.fallback'),
    },
    ocr: {
      enabled: asBool(requireField(raw, 'ocr.enabled'), 'ocr.enabled'),
      provider: asString(requireField(raw, 'ocr.provider'), 'ocr.provider'),
      credentials: (requireField(raw, 'ocr.credentials') as Record<string, string>),
    },
    llm: {
      enabled: asBool(requireField(raw, 'llm.enabled'), 'llm.enabled'),
      provider: asString(requireField(raw, 'llm.provider'), 'llm.provider'),
      model: asString(requireField(raw, 'llm.model'), 'llm.model'),
      apiKey: typeof (raw as { llm?: { apiKey?: unknown } }).llm?.apiKey === 'string'
        ? ((raw as { llm: { apiKey: string } }).llm.apiKey)
        : '',
    },
    playwright: {
      headless: asBool(requireField(raw, 'playwright.headless'), 'playwright.headless'),
      timeoutMs: asNumber(requireField(raw, 'playwright.timeoutMs'), 'playwright.timeoutMs'),
    },
    log: {
      level: (() => {
        const v = (raw as { log?: { level?: unknown } }).log?.level;
        if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
        return 'info';
      })(),
    },
  };

  if (cfg.filter.matchSubject === false && cfg.filter.matchBody === false) {
    throw new Error('config.filter: at least one of matchSubject / matchBody must be true');
  }
  if (cfg.filter.sinceDays <= 0) {
    throw new Error('config.filter.sinceDays must be > 0');
  }
  if (cfg.filter.since && cfg.filter.until) {
    if (Date.parse(cfg.filter.since) > Date.parse(cfg.filter.until)) {
      throw new Error('config.filter.since must be <= config.filter.until');
    }
  }
  if (cfg.imap.port <= 0 || cfg.imap.port > 65535) {
    throw new Error('config.imap.port must be in 1..65535');
  }
  if (cfg.ocr.enabled) {
    throw new Error('config.ocr.enabled=true is not supported in this build');
  }
  if (cfg.llm.enabled) {
    throw new Error('config.llm.enabled=true is not supported in this build');
  }

  return cfg;
}
