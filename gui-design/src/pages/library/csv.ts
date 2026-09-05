/**
 * 把当前列表拼成 CSV 文本。
 *
 * 桥接层没有「另存为」通道（只有 copyText），所以导出的结果是放进剪贴板，
 * 由用户粘到表格软件里。不加 BOM：粘贴时 BOM 会变成可见的乱码字符。
 */
import type { InvoiceRow } from '../../bridge/index.js';
import { humanizeDocumentType } from './documentType.js';
import { statusLabel } from '../../components/index.js';

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
