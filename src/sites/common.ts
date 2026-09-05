import AdmZip from 'adm-zip';
import type { Ctx, DocumentFormat, PdfArtifact } from '../extract/types.js';
import { assertPublicUrl, readCappedBuffer, MAX_DOC_BYTES } from '../util/net.js';
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
/**
 * 允许下钻的 ZIP 层数（外层包算第 1 层）。
 *
 * 票根网（`service@invoice.txffp.com`）的通行费发票有两种投递格式：一种是
 * `通行费电子发票.zip` 里直接放 `1_<纳税人识别号>_<uuid>.pdf`；另一种是**包中包**
 * ——外层每个开票方一个 `<纳税人识别号>_<uuid>.zip`，真正的 PDF/OFD/XML 在里面。
 * 只解一层时后者会一份票都取不到（实测 10 封邮件、68 个 PDF/OFD 条目静默丢失）。
 *
 * 深度仍然收紧到 2：观察到的真实格式只嵌套一层，每多允许一层就多一层解压攻击面。
 * 超出深度的 `.zip` 条目会记进 `skipped`，形成可见的部分失败，绝不静默丢弃。
 */
const MAX_ZIP_NESTING_DEPTH = 2;

export { decodeHtmlEntities };

/**
 * 日志 / pending 边界的 URL 脱敏（CORE-08）。
 * 镜像 `pipeline.redactUrlForLog`：只保留 scheme + host + 截断 path，去掉 query/hash
 * （签名 URL 的 token 即凭据，不得写入日志或持久化原因串）。
 */
export function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 96 ? `${u.pathname.slice(0, 96)}…` : u.pathname;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '[invalid-url]';
  }
}

/** 错误串 / 原因串里若夹带 URL，脱敏后再写入日志或 pending。 */
export function redactErrorDetail(detail: string): string {
  return detail.replace(/https?:\/\/[^\s"'<>\\]+/gi, (m) => redactUrlForLog(m));
}

/** decodeURIComponent that never throws on malformed percent-encoding. */
export function tryDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * OFD 包必须在根目录（或仅前导 ./）带 `OFD.xml`（GB/T 33190）。
 * 没有它的 PK 容器是普通 ZIP，应解出内部发票条目，而不是整包当 OFD 归档。
 */
export function looksLikeOfdPackage(data: Buffer): boolean {
  if (data.length < 4 || data.subarray(0, 2).toString('latin1') !== 'PK') return false;
  try {
    const zip = new AdmZip(data);
    const declared = zip.getEntryCount();
    if (declared > MAX_ZIP_TOTAL_ENTRIES) return false;
    return zip.getEntries().some((entry) => {
      if (entry.isDirectory) return false;
      const leaf = entry.entryName.replace(/^[./\\]+/, '').toLowerCase();
      return leaf === 'ofd.xml';
    });
  } catch {
    return false;
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
  // WIRE-01：ctx.http 已是 safeFetch（逐跳校验 + DNS pin）。前置 assertPublicUrl
  // 仍作快速失败；不再依赖事后 assertPublicResponse（redirect 已在发出前拦截）。
  await assertPublicUrl(url);
  const response = await ctx.http(url, {
    headers: {
      Accept: 'application/pdf,application/zip,application/octet-stream,*/*',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
      ...(referer ? { Referer: referer } : {}),
    },
  });

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
  /**
   * 包内出现过、但不是可归档格式的条目后缀（小写，含点；无后缀记 `''`）。
   *
   * 调用方用它区分「这个压缩包里根本没有票」和「这是数电发票的 XML 副本」：
   * 后者是同一张票的机读版本，`formatForEntry` 永远不会接受它，手动归档也不收，
   * 因此在 PDF 已经归档的前提下不该再把整封邮件挂进待确认（EXT-13）。
   */
  unsupportedExtensions: string[];
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
/** 整次解包（含所有嵌套层）共享的预算：嵌套包不得让上限翻倍。 */
interface ZipWalkState {
  documents: PdfArtifact[];
  skipped: string[];
  unsupported: Set<string>;
  totalBytes: number;
  supportedCount: number;
  /** 命中文档数上限后停止继续取件（跨层生效）。 */
  documentLimitHit: boolean;
}

/** 解压一个条目并复核尺寸/压缩比；返回 null 表示已记入 skipped。 */
function readZipEntry(
  entry: ReturnType<AdmZip['getEntries']>[number],
  label: string,
  state: ZipWalkState,
): Buffer | null {
  const declared = entry.header.size;
  const compressed = entry.header.compressedSize;
  if (declared > MAX_ZIP_ENTRY_BYTES || state.totalBytes + declared > MAX_ZIP_TOTAL_BYTES) {
    state.skipped.push(`${label}:zip_size_cap`);
    return null;
  }
  // zip bomb 防护：高压缩比且解压后体量可观的条目直接跳过，绝不 getData()。
  const ratio = compressed > 0 ? declared / compressed : declared;
  if (declared > ZIP_RATIO_FLOOR_BYTES && ratio > MAX_ZIP_RATIO) {
    state.skipped.push(`${label}:zip_ratio_${Math.round(ratio)}`);
    return null;
  }

  let content: Buffer;
  try {
    content = entry.getData();
  } catch (err) {
    state.skipped.push(`${label}:zip_entry_unreadable:${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  // 声明大小可以撒谎，解压后按真实长度复核一次。
  if (content.length > MAX_ZIP_ENTRY_BYTES || state.totalBytes + content.length > MAX_ZIP_TOTAL_BYTES) {
    state.skipped.push(`${label}:zip_size_cap`);
    return null;
  }
  state.totalBytes += content.length;
  return content;
}

/** 一层 ZIP 的遍历。`depth` 从 1 开始（最外层包）。 */
function walkZip(data: Buffer, source: string, depth: number, state: ZipWalkState): void {
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
    const detail = `zip_unreadable:${err instanceof Error ? err.message : String(err)}`;
    // 最外层解不开仍然抛给调用方（既有契约）；内层只记 skipped，不牵连兄弟条目。
    if (depth === 1) throw new Error(detail);
    state.skipped.push(`${source}:${detail}`);
    return;
  }

  for (const entry of entries) {
    if (state.documentLimitHit) return;
    if (entry.isDirectory) continue;
    const entryName = entry.name;
    const label = `${source}/${entryName}`;

    // 包中包：票根网通行费发票的第二种投递格式。`.ofd` 虽然也是 PK 容器，但它
    // 本身就是要归档的文档，由下面的 formatForEntry 分支整包收下，不在这里下钻。
    if (/\.zip$/i.test(entryName)) {
      if (depth >= MAX_ZIP_NESTING_DEPTH) {
        state.skipped.push(`${label}:zip_nesting_depth_${MAX_ZIP_NESTING_DEPTH}`);
        continue;
      }
      const nested = readZipEntry(entry, label, state);
      if (!nested) continue;
      // 后缀说是 zip，magic 也必须是 PK，否则按“后缀撒谎”记 skipped。
      const nestedKind = detectDocumentKind(nested);
      if (nestedKind !== 'archive') {
        state.skipped.push(`${label}:magic_mismatch:claimed_zip:got_${nestedKind}`);
        continue;
      }
      walkZip(nested, label, depth + 1, state);
      continue;
    }

    const format = formatForEntry(entryName);
    if (!format) {
      const dot = entryName.lastIndexOf('.');
      state.unsupported.add(dot > 0 ? entryName.slice(dot).toLowerCase() : '');
      continue;
    }

    if (++state.supportedCount > MAX_ZIP_DOCUMENTS) {
      state.skipped.push(`${source}/*:zip_document_limit_${MAX_ZIP_DOCUMENTS}`);
      state.documentLimitHit = true;
      return;
    }

    const content = readZipEntry(entry, label, state);
    if (!content) continue;

    // EXT-08：后缀与 magic 不一致时跳过并记入 skipped，避免把 JSON 错误页当 PDF。
    const kind = detectDocumentKind(content);
    if (format === 'pdf' && kind !== 'pdf') {
      state.skipped.push(`${label}:magic_mismatch:claimed_pdf:got_${kind}`);
      continue;
    }
    if (format === 'ofd' && kind !== 'archive') {
      state.skipped.push(`${label}:magic_mismatch:claimed_ofd:got_${kind}`);
      continue;
    }
    if (format === 'image' && kind !== 'image') {
      state.skipped.push(`${label}:magic_mismatch:claimed_image:got_${kind}`);
      continue;
    }

    const leaf = entryName.split('/').pop() || entryName;
    const suggestedName = safeFilename(leaf, format === 'pdf' ? 'invoice.pdf' : `invoice.${format === 'ofd' ? 'ofd' : 'png'}`);
    // documentType / requiresOcr 交给归档阶段的 withDocumentClassification 统一判定，
    // 这样包内的“订单明细/结账单”仍会被识别为 supporting 而不是发票。
    state.documents.push({
      data: content,
      source: label,
      suggestedName,
      format,
    });
  }
}

export function documentsFromZip(data: Buffer, source: string): ZipExtraction {
  const state: ZipWalkState = {
    documents: [],
    skipped: [],
    unsupported: new Set<string>(),
    totalBytes: 0,
    supportedCount: 0,
    documentLimitHit: false,
  };

  walkZip(data, source, 1, state);

  // 包内 `<stem>.pdf` + `<stem>.ofd` 的去重不在这里做：它与「同一封邮件的两个同名
  // 附件」是同一条规则，统一由 `preferPdfOverDuplicateOfd()` 按 containerStemKey
  // 判定（EXT-16），免得同一件事有两处实现、各自漂移。
  return {
    documents: state.documents,
    skipped: state.skipped,
    unsupportedExtensions: [...state.unsupported],
  };
}
