/**
 * 归档文件的类型判定与中文名。
 *
 * 后端在不同阶段写进 `documentType` 的值不一样：管道分类写的是
 * `invoice` / `itinerary` / `supporting`，识别引擎回填的 `invoiceType` 是票面口径
 * （`digital_normal_invoice`、`增值税专用发票`、`train_ticket` 这一类）。界面只认
 * 一个中文名，所以两处合起来判断，从最具体的规则往下匹配。
 *
 * 「数电」只在识别结果明确说了是数电票（`invoiceType` 以 `digital` 打头）时才出现；
 * 拿不准就用「普通发票 / 专用发票」，不替用户猜票种。
 */
import type { InvoiceRow } from '../bridge/index.js';

/** 只需要类型字段，方便台账行、OCR 记录、去重成员共用。 */
export type DocumentTypeSource = Pick<InvoiceRow, 'documentType' | 'invoiceType'>;

function typeText(row: DocumentTypeSource): string {
  return `${row.documentType ?? ''} ${row.invoiceType ?? ''}`.toLowerCase();
}

/**
 * 附属材料：报销时用不上的支撑件（结算单、汇总单一类）。
 * 发票库默认把它们藏起来，只在「附属材料」筛选里出现。
 */
export function isSupportingDocument(row: DocumentTypeSource): boolean {
  return /supporting|支撑|附属|汇总/.test(typeText(row));
}

/** 数电票由识别结果说了算：`invoiceType` 以 digital 打头才算。 */
function isDigital(row: DocumentTypeSource): boolean {
  return /^digital[_-]?/i.test((row.invoiceType ?? '').trim());
}

const SUPPORTING = /supporting|支撑|附属|汇总/;
const TRAIN = /铁路|火车|train|rail/;
const ITINERARY = /行程单|itinerary|航空|机票|e-?ticket/;
const SPECIAL = /专用|专票|special/;
const NORMAL = /普通|普票|normal|general/;
const GENERIC = /发票|invoice|fapiao/;

/** 列表和详情里显示的类型名；识别前是「待识别」。 */
export function humanizeDocumentType(row: DocumentTypeSource): string {
  const text = typeText(row);
  if (!text.trim()) return '待识别';
  if (SUPPORTING.test(text)) return '附属材料';
  if (TRAIN.test(text)) return '火车票';
  if (ITINERARY.test(text)) return '行程单';
  const digital = isDigital(row);
  if (SPECIAL.test(text)) return digital ? '数电专票' : '专用发票';
  if (NORMAL.test(text)) return digital ? '数电普票' : '普通发票';
  if (GENERIC.test(text)) return digital ? '数电发票' : '发票';
  return (row.invoiceType || row.documentType).trim() || '待识别';
}

/** OCR 记录里的引擎名。 */
export function humanizeVendor(value: string): string {
  if (!value) return '—';
  if (/tencent/i.test(value)) return '腾讯云';
  if (/efapiao/i.test(value)) return '本机引擎';
  if (/mock/i.test(value)) return '模拟引擎';
  return value;
}

/** OCR 记录里的取字方式：票面自带文字，还是靠图像识别。 */
export function humanizeExtractedBy(value: string): string {
  if (!value) return '—';
  if (/text|pdf/i.test(value)) return '文本解析';
  if (/ocr|image/i.test(value)) return '图像识别';
  return humanizeVendor(value);
}
