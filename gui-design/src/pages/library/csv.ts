/**
 * 把当前列表拼成 CSV 文本。
 *
 * 不加 BOM：主进程写盘时自己补，粘贴到表格软件时 BOM 会变成可见的乱码字符。
 */
import type { InvoiceRow } from '../../bridge/index.js';
import { humanizeDocumentType, statusLabel } from '../../components/index.js';

const HEADERS = ['日期', '销售方', '发票号', '金额', '类型', '状态', '文件'] as const;

function escape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
