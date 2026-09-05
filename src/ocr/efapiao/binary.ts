import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../log.js';
import type { Config } from '../../config.js';
import type { DocumentFormat } from '../../extract/types.js';

export const EFAPIAO_VERSIONS = ['0.1.4', '0.1.3'] as const;

interface ResolvedBinary {
  path: string;
  version?: string;
}

function platformArch(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x86_64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x86_64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x86_64';
  return `${process.platform}-${process.arch}`;
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

function resourceRoots(): string[] {
  return [
    process.env.MFH_RESOURCE_ROOT,
    process.env.MFH_APP_ROOT,
    repoRoot(),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function findBinaryInDir(dir: string, exe: string): string | undefined {
  const candidate = path.join(dir, exe);
  if (fs.existsSync(candidate)) return candidate;
  if (!fs.existsSync(dir)) return undefined;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name, exe);
    if (fs.existsSync(nested)) return nested;
  }
  return undefined;
}

function bundledBinary(): ResolvedBinary | undefined {
  const exe = process.platform === 'win32' ? 'efapiao.exe' : 'efapiao';
  for (const version of EFAPIAO_VERSIONS) {
    for (const root of resourceRoots()) {
      const found = findBinaryInDir(path.join(root, 'vendor', 'efapiao', version, platformArch()), exe);
      if (found) return { path: found, version };
    }
  }
  return undefined;
}

function resolveBinary(cfg: Config): ResolvedBinary {
  if (cfg.ocr.binaryPath !== 'auto') return { path: cfg.ocr.binaryPath };
  return bundledBinary() ?? { path: 'efapiao' };
}

/** Bundled directory version; custom/PATH engines must report their own version. */
export function resolvedBinaryVersion(cfg: Config): string | undefined {
  return resolveBinary(cfg).version;
}

export function binaryPath(cfg: Config): string {
  const resolved = resolveBinary(cfg);
  if (resolved.version && resolved.version !== EFAPIAO_VERSIONS[0]) {
    log.info(`E-Fapiao-OCR selected bundled version ${resolved.version} for ${platformArch()} (preferred ${EFAPIAO_VERSIONS[0]})`);
  }
  return resolved.path;
}

function binaryDir(cfg: Config): string | undefined {
  const bin = binaryPath(cfg);
  if (bin === 'efapiao') return undefined;
  return path.dirname(bin);
}

function hasBundledModels(cfg: Config): boolean {
  const dir = binaryDir(cfg);
  return dir ? fs.existsSync(path.join(dir, 'models')) : false;
}

export function efapiaoEnv(cfg: Config): NodeJS.ProcessEnv {
  const credentials = cfg.ocr.credentials ?? {};
  const configuredVendor = process.env.EFAPIAO_OCR_VENDOR || credentials.ocrVendor;
  const ocrVendor = configuredVendor
    || (credentials.tencentSecretId || credentials.tencentSecretKey ? 'tencent' : '')
    || (hasBundledModels(cfg) ? 'cnocr' : 'none');
  return {
    ...process.env,
    EFAPIAO_OCR_VENDOR: ocrVendor,
    EFAPIAO_API_KEY: credentials.apiKey || process.env.EFAPIAO_API_KEY,
    EFAPIAO_CNOCR_MODEL_PROFILE: credentials.cnocrModelProfile || process.env.EFAPIAO_CNOCR_MODEL_PROFILE,
    EFAPIAO_CNOCR_DET_MODEL: credentials.cnocrDetModel || process.env.EFAPIAO_CNOCR_DET_MODEL,
    EFAPIAO_CNOCR_REC_MODEL: credentials.cnocrRecModel || process.env.EFAPIAO_CNOCR_REC_MODEL,
    TENCENTCLOUD_SECRET_ID: credentials.tencentSecretId || credentials.secretId || process.env.TENCENTCLOUD_SECRET_ID,
    TENCENTCLOUD_SECRET_KEY: credentials.tencentSecretKey || credentials.secretKey || process.env.TENCENTCLOUD_SECRET_KEY,
    TENCENTCLOUD_REGION: credentials.tencentRegion || credentials.region || process.env.TENCENTCLOUD_REGION,
    TENCENT_SECRET_ID: credentials.tencentSecretId || credentials.secretId || process.env.TENCENT_SECRET_ID,
    TENCENT_SECRET_KEY: credentials.tencentSecretKey || credentials.secretKey || process.env.TENCENT_SECRET_KEY,
    TENCENT_REGION: credentials.tencentRegion || credentials.region || process.env.TENCENT_REGION,
  };
}

export function hintFor(format: DocumentFormat): string {
  if (format === 'image') return 'image';
  return format === 'ofd' ? 'ofd' : 'pdf';
}

export function ocrModeFor(cfg: Config): string {
  return cfg.ocr.ocrMode ?? 'auto';
}
