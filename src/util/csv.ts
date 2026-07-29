import fs from 'node:fs';
import path from 'node:path';

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

/**
 * CORE-05：保证 CSV 具备期望表头。
 * - 不存在或 size=0：原子写 BOM + header
 * - 非空：解析首行并严格比对，不匹配则抛错（禁止向未知 schema 盲目追加）
 *
 * `expectedHeader` 可以带或不带尾部换行；比较时忽略 BOM 与空白差异。
 */
export function ensureCsvSchema(csvPath: string, expectedHeader: string): void {
  const headerLine = expectedHeader.replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
  const dir = path.dirname(csvPath);
  fs.mkdirSync(dir, { recursive: true });

  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(csvPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    st = undefined;
  }

  if (!st || st.size === 0) {
    const tmp = `${csvPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `\uFEFF${headerLine}\n`, 'utf8');
    fs.renameSync(tmp, csvPath);
    return;
  }

  // 只读出足够判定表头的前缀，避免大文件全量加载。
  const fd = fs.openSync(csvPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '');
    // 在 quote 外找首行结束；表头本身不应含换行。
    const nl = text.search(/\r?\n/);
    const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
    const expected = headerLine.trim();
    if (firstLine !== expected) {
      throw new Error(
        `csv_schema_mismatch:${csvPath}: expected header ${JSON.stringify(expected)}, got ${JSON.stringify(firstLine)}`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
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
