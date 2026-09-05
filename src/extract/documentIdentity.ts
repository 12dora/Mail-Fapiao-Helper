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
 * 「同一次投递里的同一个词干」身份（EXT-16）。返回 null 表示不适用。
 *
 * 这**不是** EXT-01 禁止的那种「按文件名跨来源去重」。它要求两份文件来自同一封
 * 邮件的**同一个容器**——同一个压缩包内的同一目录，或同为该邮件的直接附件——
 * 而且词干逐字相同、只有扩展名不同。开票方按这个约定同时给出 PDF 与 OFD：
 *
 *   通行费电子发票.zip/913…_1891…zip/1891….pdf  +  …/1891….ofd
 *   携程酒店订单1128144409057843电子发票.pdf     +  …….ofd
 *
 * 直链下载不参与（URL 路径的同名毫无保证），通用词干（`发票`、`invoice`、`下载`
 * 之类）也不参与——那正是不同票最容易撞名的地方，交给既有的发票号判据。
 */
export function containerStemKey(source: string): string | null {
  if (!source) return null;
  // 直链：URL 上的同名不构成同一次投递。
  if (/^https?:\/\//i.test(source)) return null;
  const stripped = source.replace(/\.[^./]*$/, '');
  if (stripped.length === 0) return null;
  const leaf = stripped.split('/').pop() ?? '';
  const normalizedLeaf = leaf.toLowerCase().replace(/[\s_()（）【】[\]-]+/g, '').trim();
  if (isGenericDocumentStem(normalizedLeaf)) return null;
  return stripped;
}

/** 两个 artifact 是不是同一次投递、同一个词干的两种格式？ */
function sameContainerDelivery(a: PdfArtifact, b: PdfArtifact): boolean {
  const keyA = containerStemKey(a.source);
  if (keyA === null) return false;
  return keyA === containerStemKey(b.source);
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

    // 仅当同一邮件里的某个 PDF 可证明是同一份文档才丢弃 OFD，两条判据都是强身份：
    //   a) 两边 20 位发票号一致（EXT-01：号码不等则强制 distinct，禁止回落到文件名）
    //   b) 同一次投递的同一个容器 + 同一个非通用词干（EXT-16）
    // 单纯的文件名撞名仍然不足以删除——(b) 要求同容器且词干非通用。
    const duplicatePdf = pdfs.find((pdf) => sameDocument(artifact, pdf) || sameContainerDelivery(artifact, pdf));
    if (duplicatePdf) {
      log.debug(`Filtered duplicate OFD invoice ${artifact.source}; keeping PDF ${duplicatePdf.source}`);
      continue;
    }

    out.push({ ...artifact, documentType: artifact.documentType ?? 'invoice', requiresOcr: true });
  }

  return out;
}
