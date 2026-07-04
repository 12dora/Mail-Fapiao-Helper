import fs from 'node:fs';

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

export function readCsvRows(csvPath: string): Record<string, string>[] {
  if (!fs.existsSync(csvPath)) return [];
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
