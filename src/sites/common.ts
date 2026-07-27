import AdmZip from 'adm-zip';
import type { Ctx, DocumentFormat, PdfArtifact } from '../extract/types.js';
import { assertPublicUrl, assertPublicResponse, readCappedBuffer, MAX_DOC_BYTES } from '../util/net.js';
import { decodeHtmlEntities } from '../util/url.js';

/** ZIP 解压防护上限（APP-09）：条目数、单条解压大小、总解压大小、压缩比。 */
/** 中央目录项总数的硬上限，在物化任何 ZipEntry 之前判定。 */
const MAX_ZIP_TOTAL_ENTRIES = 4096;
/** 实际取出的受支持文档数量上限。 */
const MAX_ZIP_DOCUMENTS = 512;
const MAX_ZIP_ENTRY_BYTES = MAX_DOC_BYTES;
const MAX_ZIP_TOTAL_BYTES = MAX_DOC_BYTES;
/** 超过该压缩比且解压后超过 `ZIP_RATIO_FLOOR_BYTES` 的条目视为 zip bomb。 */
const MAX_ZIP_RATIO = 200;
const ZIP_RATIO_FLOOR_BYTES = 1024 * 1024;

export { decodeHtmlEntities };

/** decodeURIComponent that never throws on malformed percent-encoding. */
export function tryDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function filenameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last && last.toLowerCase().endsWith('.pdf')) return tryDecodeURIComponent(last);
  } catch {
    // fall through
  }
  return fallback;
}

export function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

// ---------------------------------------------------------------------------
// 文档响应校验（APP-10D）
// ---------------------------------------------------------------------------

/** 由 magic bytes 判定的响应体真实类型；`archive` 覆盖 ZIP 与 OFD（都是 PK 头）。 */
export type DocumentKind = 'pdf' | 'archive' | 'image' | 'unknown';

function isImageMagic(data: Buffer): boolean {
  if (data.length >= 8 && data.subarray(0, 4).toString('latin1') === '\x89PNG') return true;
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true;
  if (data.length >= 4 && data.subarray(0, 4).toString('latin1') === 'GIF8') return true;
  if (data.length >= 2 && data.subarray(0, 2).toString('latin1') === 'BM') return true;
  if (data.length >= 12
      && data.subarray(0, 4).toString('latin1') === 'RIFF'
      && data.subarray(8, 12).toString('latin1') === 'WEBP') return true;
  return false;
}

/**
 * 只看字节，不看 MIME。诺诺此前只接受 `application/pdf`（会拒绝带 `%PDF` 头的
 * 通用 MIME），平安则把任意 `application/octet-stream` 当 PDF（会归档 JSON 错误页）
 * ——两者方向正好相反，现在统一由本函数判定（APP-10D）。
 */
export function detectDocumentKind(data: Buffer): DocumentKind {
  // PK 头先判，避免 ZIP 里内嵌的 PDF 字节把整个压缩包误判成 PDF。
  if (data.length >= 2 && data.subarray(0, 2).toString('latin1') === 'PK') return 'archive';
  // 少数网关会在 PDF 前塞入空白/BOM，允许在前 1KB 内寻找签名。
  if (data.subarray(0, 1024).includes('%PDF')) return 'pdf';
  if (isImageMagic(data)) return 'image';
  return 'unknown';
}

/**
 * 校验一个“应当是文档”的响应体。声明为 PDF 的响应同样要核对签名；通用 MIME
 * （octet-stream 等）必须配合 magic bytes 才放行。不通过时抛出
 * `<label>_no_document:<contentType>:<kind>`，由 pipeline 降级为待确认。
 */
export function assertDocumentResponse(opts: {
  data: Buffer;
  contentType: string;
  label: string;
  allow?: DocumentKind[];
}): DocumentKind {
  const allow = opts.allow ?? ['pdf'];
  const kind = detectDocumentKind(opts.data);
  if (allow.includes(kind)) return kind;
  throw new Error(`${opts.label}_no_document:${opts.contentType || 'unknown'}:${kind}`);
}

export async function fetchBuffer(url: string, ctx: Ctx, referer?: string): Promise<{ data: Buffer; contentType: string; contentDisposition: string }> {
  // SSRF guard: reject non-http(s) and private/loopback targets before fetching,
  // then re-validate the final URL after any redirects.
  await assertPublicUrl(url);
  const response = await assertPublicResponse(await ctx.http(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/pdf,application/zip,application/octet-stream,*/*',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
      ...(referer ? { Referer: referer } : {}),
    },
  }));

  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }

  return {
    data: await readCappedBuffer(response),
    contentType: response.headers.get('content-type') ?? '',
    contentDisposition: response.headers.get('content-disposition') ?? '',
  };
}

// ---------------------------------------------------------------------------
// ZIP 解包（APP-09 防护 + APP-10C 支持 OFD / 图片）
// ---------------------------------------------------------------------------

const IMAGE_ENTRY_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function formatForEntry(name: string): DocumentFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.ofd')) return 'ofd';
  if (IMAGE_ENTRY_RE.test(lower)) return 'image';
  return null;
}

export interface ZipExtraction {
  documents: PdfArtifact[];
  /** 被防护规则挡下的条目，供调用方形成可见的部分失败记录。 */
  skipped: string[];
}

/**
 * 从 ZIP 中提取全部受支持的发票文档（PDF / OFD / 明确允许的图片）。
 *
 * 此前的 `pdfsFromZip()` 只保留 `.pdf`，导致合法的 OFD-only 包被报成 `*_no_pdf`
 * （APP-10C）；同时它在调用 `getData()` 前只检查声明大小，缺少条目数以外的
 * 压缩比防护（APP-09）。这里在解压前用声明大小 + 压缩比预筛，解压后再用实际
 * 大小复核（ZIP 头里的声明大小并不可信）。
 *
 * 条目数硬上限必须在 `getEntries()` **之前**用 `getEntryCount()` 判定：adm-zip 的
 * 构造函数只读中央目录主头（`readEntries: false`），`getEntryCount()` 直接返回
 * `mainHeader.diskEntries`，而 `getEntries()` 会为声明的每一个目录项物化 ZipEntry
 * 对象。只在循环里对“受支持后缀”计数，等于让几十万个不支持后缀的目录项绕过上限，
 * 在解压前就吃掉大量 CPU/内存（APP-09）。
 */
export function documentsFromZip(data: Buffer, source: string): ZipExtraction {
  const documents: PdfArtifact[] = [];
  const skipped: string[] = [];
  let total = 0;
  let supportedCount = 0;

  let entries: ReturnType<AdmZip['getEntries']>;
  try {
    const zip = new AdmZip(data);
    // 先按“全部中央目录项”硬上限拒绝，再物化条目。
    const declaredEntries = zip.getEntryCount();
    if (declaredEntries > MAX_ZIP_TOTAL_ENTRIES) {
      throw new Error(`zip_entry_count_${declaredEntries}_over_${MAX_ZIP_TOTAL_ENTRIES}`);
    }
    entries = zip.getEntries();
  } catch (err) {
    throw new Error(`zip_unreadable:${err instanceof Error ? err.message : String(err)}`);
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = entry.name;
    const format = formatForEntry(entryName);
    if (!format) continue;

    if (++supportedCount > MAX_ZIP_DOCUMENTS) {
      skipped.push(`${source}/*:zip_document_limit_${MAX_ZIP_DOCUMENTS}`);
      break;
    }

    const declared = entry.header.size;
    const compressed = entry.header.compressedSize;
    if (declared > MAX_ZIP_ENTRY_BYTES || total + declared > MAX_ZIP_TOTAL_BYTES) {
      skipped.push(`${source}/${entryName}:zip_size_cap`);
      continue;
    }
    // zip bomb 防护：高压缩比且解压后体量可观的条目直接跳过，绝不 getData()。
    const ratio = compressed > 0 ? declared / compressed : declared;
    if (declared > ZIP_RATIO_FLOOR_BYTES && ratio > MAX_ZIP_RATIO) {
      skipped.push(`${source}/${entryName}:zip_ratio_${Math.round(ratio)}`);
      continue;
    }

    let content: Buffer;
    try {
      content = entry.getData();
    } catch (err) {
      skipped.push(`${source}/${entryName}:zip_entry_unreadable:${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // 声明大小可以撒谎，解压后按真实长度复核一次。
    if (content.length > MAX_ZIP_ENTRY_BYTES || total + content.length > MAX_ZIP_TOTAL_BYTES) {
      skipped.push(`${source}/${entryName}:zip_size_cap`);
      continue;
    }
    total += content.length;

    const leaf = entryName.split('/').pop() || entryName;
    const suggestedName = safeFilename(leaf, format === 'pdf' ? 'invoice.pdf' : `invoice.${format === 'ofd' ? 'ofd' : 'png'}`);
    // documentType / requiresOcr 交给归档阶段的 withDocumentClassification 统一判定，
    // 这样包内的“订单明细/结账单”仍会被识别为 supporting 而不是发票。
    documents.push({
      data: content,
      source: `${source}/${entryName}`,
      suggestedName,
      format,
    });
  }

  return { documents, skipped };
}
