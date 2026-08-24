import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asObject } from './payload.js';
import { readConfigStrict } from './configService.js';
import { dataDir } from './runtime.js';

// ---------------------------------------------------------------------------
// 临时文件与 OCR run config（APP-22）
// ---------------------------------------------------------------------------

// 本进程创建的临时目录，退出时（含异常路径）必须清掉（APP-22）。
const activeTempDirs = new Set<string>();

export function tempRoot(): string {
  return path.join(dataDir, '.mfh-cache', 'tmp');
}

/** 创建一个仅当前用户可读写的唯一临时目录。 */
export function createTempDir(prefix: string): string {
  const dir = path.join(tempRoot(), `${prefix}-${process.pid}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 非 POSIX 平台忽略。
  }
  activeTempDirs.add(dir);
  return dir;
}

export function removeTempDir(dir: string): void {
  activeTempDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function cleanupAllTempDirs(): void {
  for (const dir of Array.from(activeTempDirs)) removeTempDir(dir);
}

/**
 * 启动时清理上次崩溃/强退遗留的临时配置：持有者进程已经不存在的目录，以及旧版本
 * 写在可预测路径上的 `ocr-run-config.json`。
 */
export function cleanupStaleTempDirs(): void {
  try {
    fs.rmSync(path.join(dataDir, '.mfh-cache', 'ocr-run-config.json'), { force: true });
  } catch {
    // best-effort
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tempRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^[a-z]+-(\d+)-[0-9a-f]+$/.exec(entry.name);
    const pid = match ? Number(match[1]) : NaN;
    if (Number.isInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        continue; // 持有者仍在运行，留给它自己清理。
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') continue;
      }
    }
    try {
      fs.rmSync(path.join(tempRoot(), entry.name), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * 只生成 OCR 真正需要的最小配置：保留 `ocr` 与 `paths`，其余字段用占位值填满
 * schema。IMAP 授权码与 LLM API key 不会出现在这个临时文件里（APP-22）。
 */
export function buildMinimalOcrConfig(current: Record<string, unknown>, concurrency: number): Record<string, unknown> {
  const ocr = asObject(current.ocr);
  const paths = asObject(current.paths);
  const rename = asObject(current.rename);
  const host = typeof ocr.serviceHost === 'string' && ocr.serviceHost ? ocr.serviceHost : '127.0.0.1';
  const basePort = Number(ocr.servicePort ?? 8000) || 8000;
  const port = concurrency > 1 ? basePort + concurrency - 1 : basePort;
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.length > 0 ? value : fallback;

  return {
    // 占位的邮箱配置：仅用于通过 schema 校验，OCR 流程不会读取它们。
    imap: { host: 'localhost', port: 993, user: 'ocr-run', pass: 'unused', tls: true, mailbox: ['INBOX'] },
    filter: { keywords: ['发票'], matchSubject: true, matchBody: true, sinceDays: 30 },
    paths: {
      samples: str(paths.samples, './samples/raw'),
      invoices: str(paths.invoices, './invoices'),
      pending: str(paths.pending, './pending'),
    },
    output: { csv: './invoices/invoices.csv' },
    rename: {
      rule: str(rename.rule, '{date}_{seller}_{amount}'),
      fallback: str(rename.fallback, '{hash}_{index}'),
      avoidConflictBeforeOcr: rename.avoidConflictBeforeOcr !== false,
      applyAfterOcr: false,
      organizeByType: false,
    },
    ocr: {
      ...ocr,
      serviceWorkers: concurrency,
      servicePort: port,
      serviceUrl: `http://${host}:${port}`,
    },
    playwright: { headless: true, timeoutMs: 30000 },
    network: { retries: 3, retryDelayMs: 1000 },
  };
}

export function writeOcrRunConfig(concurrency: number): { dir: string; file: string } {
  const current = readConfigStrict();
  if (!current.ok) throw new Error(current.message);
  const dir = createTempDir('ocr');
  const file = path.join(dir, 'ocr-run-config.json');
  const minimal = buildMinimalOcrConfig(current.raw, concurrency);
  fs.writeFileSync(file, `${JSON.stringify(minimal, null, 2)}\n`, { mode: 0o600 });
  return { dir, file };
}
