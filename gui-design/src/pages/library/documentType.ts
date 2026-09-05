/**
 * 归档文件的类型判定与中文名。
 *
 * 后端在不同阶段写进 `documentType` 的值不一样：OCR 结果里是
 * `invoice` / `itinerary` / `supporting`，识别引擎回填的 `invoiceType` 则是票面
 * 原文（「增值税电子普通发票」这一类）。界面只认一个中文名，所以两处合起来判断，
 * 从最具体的规则往下匹配。
 *
 * 这两个函数是发票库页唯一的类型入口；等第二个页面要用时整体搬到 components/ 或
 * bridge/ 即可，不要在别处再写一份。
 */
import type { InvoiceRow } from '../../bridge/index.js';

/** 只需要类型字段，方便台账行、OCR 记录、去重成员共用。 */
export type DocumentTypeSource = Pick<InvoiceRow, 'documentType' | 'invoiceType'>;

function typeText(row: DocumentTypeSource): string {
  return `${row.documentType ?? ''} ${row.invoiceType ?? ''}`.toLowerCase();
}

/**
 * 附属材料：报销时用不上的支撑件（费用汇总单、对账单一类）。
 * 列表默认把它们藏起来，只在「附属材料」筛选里出现。
 */
export function isSupportingDocument(row: DocumentTypeSource): boolean {
  return /supporting|支撑|附属|汇总/.test(typeText(row));
}

/** 从具体到笼统，命中即返回。顺序不能随便调：专票/普票要排在「发票」之前。 */
const TYPE_RULES: readonly (readonly [RegExp, string])[] = [
  [/supporting|支撑|附属|汇总/, '附属材料'],
  [/铁路|火车|train|rail/, '火车票'],
  [/行程单|行程|itinerary|航空|机票|e-?ticket/, '行程单'],
  [/专用|专票/, '数电专票'],
  [/普通|普票/, '数电普票'],
  [/发票|invoice|fapiao/, '发票'],
];

/** 列表和详情里显示的类型名；识别前是「待识别」。 */
export function humanizeDocumentType(row: DocumentTypeSource): string {
  const text = typeText(row);
  if (!text.trim()) return '待识别';
  for (const [pattern, label] of TYPE_RULES) {
    if (pattern.test(text)) return label;
  }
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
