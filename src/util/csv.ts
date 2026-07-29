import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * True when a cell would be interpreted as a formula by Excel / LibreOffice /
 * Google Sheets when the CSV is opened directly. We guard `= + @` and control
 * characters unconditionally, and a leading `-` only when the value is not a
 * plain (possibly negative) number — so legitimate invoice amounts such as
 * `-113.00` are left untouched while `-1+cmd|...` is neutralized.
 */
function needsFormulaGuard(s: string): boolean {
  if (s.length === 0) return false;
  const first = s[0];
  if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r' || first === '\n') {
    return true;
  }
  if (first === '-') {
    return !/^-?\d+(\.\d+)?$/.test(s);
  }
  return false;
}

export function csvCell(v: string): string {
  const guard = needsFormulaGuard(v);
  const s = guard ? `'${v}` : v;
  // Always quote a formula-guarded cell so every spreadsheet importer treats it
  // as text, in addition to quoting cells that contain separators/quotes.
  if (guard || /[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Quote-aware whole-text CSV parser. Unlike splitting on newlines and parsing
 * each line, this tracks quote state across record boundaries, so a quoted
 * field containing an embedded newline (e.g. a mail subject with a line break)
 * round-trips correctly instead of corrupting every following row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  let sawField = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
      sawField = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
      sawField = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (sawField || cur.length > 0 || row.length > 0) {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
        sawField = false;
      }
    } else {
      cur += ch;
      sawField = true;
    }
  }
  if (sawField || cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function normalizeHeaderLine(header: string): string {
  return header.replace(/^\uFEFF/, '').replace(/\r?\n$/, '').trim();
}

function fsyncDir(dir: string): void {
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Windows 等不支持目录 fsync 时忽略。
  }
}

function hardenCsvMode(file: string): void {
  if (isWindows) return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort：网络盘 / 非 POSIX 忽略。
  }
}

/**
 * 原子写入 CSV 内容（BOM + 全文），fsync 文件与父目录，POSIX 下 mode 0600。
 * 供 schema 创建与 legacy 升级共用，保证 OCR-03 的 durability。
 */
function writeCsvAtomic(csvPath: string, body: string): void {
  const dir = path.dirname(csvPath);
  fs.mkdirSync(dir, { recursive: true, mode: isWindows ? undefined : 0o700 });
  const tmp = `${csvPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const fd = fs.openSync(tmp, 'w', isWindows ? undefined : 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, csvPath);
  hardenCsvMode(csvPath);
  fsyncDir(dir);
}

export interface EnsureCsvSchemaOptions {
  /**
   * 已知可升级的旧表头（不含 BOM、可带或不带尾部换行）。
   * 命中时按列名映射重写为 expectedHeader，缺失列填空；幂等且崩溃安全（原子替换）。
   */
  upgradeFrom?: string[];
  /**
   * 升级每一行时的钩子：可按旧列填充新列（例如补 mailHash）。
   * 返回的对象会按 expectedHeader 列序写出。
   */
  upgradeRow?: (row: Record<string, string>) => Record<string, string>;
}

/**
 * CORE-05 / OCR-03 / 敏感文件 mode：
 * - 不存在或 size=0：原子写 BOM + header，fsync 文件与父目录，mode 0600
 * - 非空且表头匹配：通过
 * - 非空且表头属于 upgradeFrom：按列名迁移后原子重写
 * - 其余：抛错，禁止向未知 schema 盲目追加
 */
export function ensureCsvSchema(
  csvPath: string,
  expectedHeader: string,
  opts: EnsureCsvSchemaOptions = {},
): void {
  const headerLine = normalizeHeaderLine(expectedHeader);
  const dir = path.dirname(csvPath);
  fs.mkdirSync(dir, { recursive: true, mode: isWindows ? undefined : 0o700 });

  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(csvPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    st = undefined;
  }

  if (!st || st.size === 0) {
    writeCsvAtomic(csvPath, `\uFEFF${headerLine}\n`);
    return;
  }

  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(text);
  const firstLine = (records[0] ?? []).join(',').trim();
  // 也接受用 parseCsvLine 语义比对（与 join 在无特殊字符表头时等价）。
  const expected = headerLine.trim();
  if (firstLine === expected) {
    hardenCsvMode(csvPath);
    return;
  }

  const legacy = (opts.upgradeFrom ?? []).map(normalizeHeaderLine);
  if (legacy.includes(firstLine)) {
    const oldHeader = records[0] ?? [];
    const newHeader = parseCsvLine(headerLine);
    const upgradeRow = opts.upgradeRow;
    const lines: string[] = [headerLine];
    for (let i = 1; i < records.length; i++) {
      const cols = records[i] ?? [];
      const row: Record<string, string> = {};
      for (let c = 0; c < oldHeader.length; c++) {
        const key = oldHeader[c];
        if (!key) continue;
        row[key] = cols[c] ?? '';
      }
      const out = upgradeRow ? upgradeRow(row) : row;
      lines.push(newHeader.map((k) => csvCell(out[k] ?? '')).join(','));
    }
    writeCsvAtomic(csvPath, `\uFEFF${lines.join('\n')}\n`);
    return;
  }

  throw new Error(
    `csv_schema_mismatch:${csvPath}: expected header ${JSON.stringify(expected)}, got ${JSON.stringify(firstLine)}`,
  );
}

export function readCsvRows(csvPath: string): Record<string, string>[] {
  if (!fs.existsSync(csvPath)) return [];
  // 空文件没有合法表头：当作尚无数据，避免把第一行数据当 header（CORE-05）。
  try {
    if (fs.statSync(csvPath).size === 0) return [];
  } catch {
    return [];
  }
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(text);
  if (records.length === 0) return [];
  const header = records[0] ?? [];
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      row[key] = cols[c] ?? '';
    }
    rows.push(row);
  }
  return rows;
}
