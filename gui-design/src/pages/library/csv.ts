/**
 * 把当前列表拼成 CSV 文本。
 *
 * 不加 BOM：主进程写盘时自己补，粘贴到表格软件时 BOM 会变成可见的乱码字符。
 */
import type { InvoiceRow } from '../../bridge/index.js';
import { humanizeDocumentType, statusLabel } from '../../components/index.js';

const HEADERS = ['日期', '销售方', '发票号', '金额', '类型', '状态', '文件'] as const;

/**
 * 与 src/util/csv.ts 的 `needsFormulaGuard` 保持逐字一致（改一处要同步另一处）：
 * 销售方与文件名来自导入的文档，`=1+1` 这类值直接开进表格软件会被当成公式执行。
 * `= + @` 与控制字符无条件加护，前导 `-` 只在不是普通数字时才加，
 * 这样 `-113.00` 这种正常的负数金额不会被改写。
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

function escape(value: string): string {
  const guard = needsFormulaGuard(value);
  const text = guard ? `'${value}` : value;
  // 加过护的单元格一律加引号，任何导入器都会把它当纯文本。
  if (guard || /[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function rowsToCsv(rows: readonly InvoiceRow[]): string {
  const lines = [HEADERS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.date,
        row.seller,
        row.invoiceNo,
        row.amount,
        humanizeDocumentType(row),
        statusLabel(row.status),
        row.filename,
      ]
        .map((value) => escape(value ?? ''))
        .join(','),
    );
  }
  return lines.join('\r\n');
}
