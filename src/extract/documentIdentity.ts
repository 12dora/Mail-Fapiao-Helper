import path from 'node:path';
import type { Ctx, PdfArtifact } from './types.js';
import { looksLikeOfdItineraryText } from './classify.js';

/**
 * 文档身份判定：判断同一封邮件里的两个 artifact 是否是同一张票的不同格式。
 *
 * 附件流程原本已有较安全的 `sameDocument()`（比对发票号 / 规范化文件名），
 * 直链流程却只判断“邮件里存在任意 PDF”，然后删掉所有非行程单 OFD，
 * 于是发票 A 的 PDF 会让不相关的发票 B 的 OFD 无提示消失（APP-02）。
 * 两条流程现在共用本模块。
 *
 * EXT-01 / EXT-07：删除 OFD 只允许在可验证的强身份（20 位发票号）一致时发生。
 * - 两个不同的 20 位发票号必须强制判定为 distinct，禁止回落到文件名匹配；
 * - 文件名（即便非通用 stem）单独匹配也绝不能触发删除——全局跨来源去重同样依赖此契约。
 * 没有可验证发票号时，宁可同时保留 PDF 与 OFD，交给 OCR 后再合并。
 */

function basename(value: string): string {
  try {
    const parsed = new URL(value);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // 不是 URL，按路径处理。
  }
  return path.basename(value);
}

/**
 * 规范化后不能单独触发 PDF/OFD 去重的通用 stem。
 * 这些名字在邮件附件/下载链接里极常见，不同发票经常撞名。
 * （保留导出供诊断/测试；删除路径不再依赖文件名身份。）
 */
const GENERIC_DOCUMENT_STEMS = new Set([
  'invoice',
  'invoices',
  'download',
  'file',
  'document',
  'attachment',
  'unnamed',
  'unnamedpdf',
  'unnamedofd',
  'pdf',
  'ofd',
  '发票',
  '电子发票',
  '增值税电子普通发票',
  '增值税电子专用发票',
  '电子普通发票',
  '电子专用发票',
  '普通发票',
  '专用发票',
  '行程单',
  '航空运输电子客票行程单',
  '下载',
  '附件',
  '文件',
]);

export function normalizedDocumentKey(artifact: PdfArtifact): string {
  let name = basename(artifact.suggestedName || artifact.source).toLowerCase();
  name = name
    .replace(/\.ofd[_\s-]*查阅需ofd阅读器/gi, '')
    .replace(/[_\s-]*查阅需ofd阅读器/gi, '')
    .replace(/\.(pdf|ofd)$/gi, '');
  return name
    .replace(/\.(pdf|ofd)$/gi, '')
    .replace(/[\s_()（）【】\[\]-]+/g, '')
    .trim();
}

/** 规范化 stem 是否属于“不能单独当身份”的通用名。 */
export function isGenericDocumentStem(stem: string): boolean {
  if (!stem) return true;
  if (GENERIC_DOCUMENT_STEMS.has(stem)) return true;
  // 纯数字短 stem（如 001、1）也没有身份意义。
  if (/^\d{1,4}$/.test(stem)) return true;
  return false;
}

export function invoiceNoKey(artifact: PdfArtifact): string {
  const haystack = `${artifact.suggestedName || ''} ${artifact.source}`;
  const match = haystack.match(/(?:^|\D)(\d{20})(?:\D|$)/);
  return match?.[1] ?? '';
}

export function looksLikeOfdItinerary(artifact: PdfArtifact): boolean {
  const text = `${artifact.suggestedName || ''} ${artifact.source}`.toLowerCase();
  return looksLikeOfdItineraryText(text);
}

/**
 * 仅当两边都有可验证的 20 位发票号且完全相同时才认为是同一份文档。
 *
 * 契约（EXT-01，对 pipeline 全局跨来源去重同样成立）：
 * 1. 两边都有发票号且相等 → same
 * 2. 两边都有发票号且不等 → 强制 distinct（禁止回落到文件名）
 * 3. 任一方缺发票号 → 不算 same（文件名匹配不足以授权删除）
 *
 * 签名保持兼容：pipeline / 提取器继续调用 `sameDocument(a, b)`。
 */
export function sameDocument(a: PdfArtifact, b: PdfArtifact): boolean {
  const aNo = invoiceNoKey(a);
  const bNo = invoiceNoKey(b);

  if (aNo && bNo) {
    // 强身份存在时以发票号为准；不等则强制 distinct。
    return aNo === bNo;
  }

  // 缺少可验证发票号时，文件名（含非通用 stem）一律不足以判定 identical。
  // 删除 OFD 必须有 matching strong invoice identity。
  return false;
}

/**
 * 同一封邮件里既有 PDF 又有 OFD 时，只丢弃“可靠匹配到同一张票的 PDF”的那份 OFD。
 * `subject` 可选：邮件主题命中行程单关键词时，OFD 一律保留为行程单。
 */
export function preferPdfOverDuplicateOfd(
  artifacts: PdfArtifact[],
  log: Ctx['log'],
  subject?: string,
): PdfArtifact[] {
  const pdfs = artifacts.filter((item) => (item.format ?? 'pdf') === 'pdf');
  const subjectIsItinerary = looksLikeOfdItineraryText(subject);
  const out: PdfArtifact[] = [];

  for (const artifact of artifacts) {
    if (artifact.format !== 'ofd') {
      out.push(artifact);
      continue;
    }

    if (subjectIsItinerary || looksLikeOfdItinerary(artifact)) {
      out.push({ ...artifact, documentType: artifact.documentType ?? 'itinerary', requiresOcr: true });
      continue;
    }

    // 仅当同一邮件里的某个 PDF 可证明是同一份文档（两边 20 位发票号一致）才丢弃 OFD。
    // 文件名撞名、或只有一方有发票号，都必须保留双方，交给 OCR 后再合并。
    const duplicatePdf = pdfs.find((pdf) => sameDocument(artifact, pdf));
    if (duplicatePdf) {
      log.debug(`Filtered duplicate OFD invoice ${artifact.source}; keeping PDF ${duplicatePdf.source}`);
      continue;
    }

    out.push({ ...artifact, documentType: artifact.documentType ?? 'invoice', requiresOcr: true });
  }

  return out;
}
