import type { ParsedMail } from 'mailparser';
import type { Ctx, ExtractIssue, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { looksLikeItineraryText } from './classify.js';
import { looksLikeOfdItinerary, preferPdfOverDuplicateOfd } from './documentIdentity.js';
import { detectDocumentKind, documentsFromZip } from '../sites/common.js';
import { MAX_DOC_BYTES } from '../util/net.js';

// Bound how much attachment data one email can pull into memory. A single
// oversized document, an aggregate over the cap, or an archive with an absurd
// entry count degrades to manual instead of risking an OOM (ARCHITECTURE R4).
const PER_DOC_CAP = MAX_DOC_BYTES;
const PER_EMAIL_CAP = MAX_DOC_BYTES;

/** 跟踪像素 / 极小装饰图阈值：宽高未知时按文件字节兜底。 */
const DECORATIVE_IMAGE_MAX_BYTES = 8 * 1024;

/** 常见签名 logo / 社交图标文件名（小写，无扩展名）。 */
const DECORATIVE_IMAGE_NAMES = new Set([
  'logo', 'signature', 'sig', 'icon', 'spacer', 'pixel', 'tracking',
  'facebook', 'twitter', 'wechat', 'weixin', 'linkedin', 'instagram',
  'banner', 'header', 'footer', 'avatar',
]);

function isPdfAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType === 'application/pdf') return true;
  if (att.filename && att.filename.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

function isOfdAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType === 'application/ofd') return true;
  if (att.contentType === 'application/vnd.ofd') return true;
  if (att.filename && att.filename.toLowerCase().endsWith('.ofd')) return true;
  return false;
}

function isZipAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType === 'application/zip') return true;
  if (att.contentType === 'application/x-zip-compressed') return true;
  if (att.filename && att.filename.toLowerCase().endsWith('.zip')) return true;
  return false;
}

function isImageAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType?.startsWith('image/')) return true;
  if (att.filename && /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.filename)) return true;
  return false;
}

type AttachmentMeta = {
  contentType?: string;
  filename?: string;
  related?: boolean;
  contentDisposition?: string;
  cid?: string;
  contentId?: string;
  content?: Buffer;
  size?: number;
};

function attachmentCid(att: AttachmentMeta): string {
  const raw = att.cid || att.contentId || '';
  return raw.replace(/^<|>$/g, '').trim().toLowerCase();
}

function filenameStem(name: string | undefined): string {
  if (!name) return '';
  return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * 从 HTML 正文收集被引用的 CID（`cid:` 与 `src="cid:..."`）。
 * 仅当 related 部件的 CID 确实被正文引用时，才更可能是装饰资源。
 */
function collectReferencedCids(mail: ParsedMail): Set<string> {
  const cids = new Set<string>();
  const html = typeof mail.html === 'string' ? mail.html : '';
  if (!html) return cids;
  const re = /(?:src|href)\s*=\s*["']?\s*cid:([^"'\s>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (match[1]) cids.add(match[1].replace(/^<|>$/g, '').trim().toLowerCase());
  }
  return cids;
}

/**
 * 图片附件处置（EXT-04）。
 *
 * 只有「正文引用的 related CID」+「装饰性尺寸/文件名」组合证据才允许静默丢弃。
 * 任一弱信号单独出现时保留图片并记 issue，避免小体积发票截图/命名像 logo 的真票消失。
 * `inline`  alone 不再构成丢弃理由。
 */
type ImageDisposition =
  | { action: 'discard' }
  | { action: 'keep' }
  | { action: 'keep_with_issue'; reason: string };

function classifyImageAttachment(att: AttachmentMeta, referencedCids: Set<string>): ImageDisposition {
  if (!isImageAttachment(att)) return { action: 'keep' };

  const size = att.content?.length ?? att.size ?? 0;
  const stem = filenameStem(att.filename);
  const decorativeName = !!(stem && DECORATIVE_IMAGE_NAMES.has(stem));
  const decorativeSize = size > 0 && size <= DECORATIVE_IMAGE_MAX_BYTES;
  const cid = attachmentCid(att);
  const referencedRelated = att.related === true && !!cid && referencedCids.has(cid);

  // 组合证据：被正文引用的 related 部件，且尺寸/文件名也像装饰资源 → 可静默丢弃。
  if (referencedRelated && (decorativeSize || decorativeName)) {
    return { action: 'discard' };
  }

  // 弱信号不足以丢弃：保留，但把不确定性上报，禁止静默“当装饰图跳过”。
  if (referencedRelated || decorativeSize || decorativeName) {
    const label = att.filename || att.cid || att.contentId || 'inline-image';
    const signals: string[] = [];
    if (referencedRelated) signals.push('cid_related');
    if (decorativeSize) signals.push('small');
    if (decorativeName) signals.push('name');
    return {
      action: 'keep_with_issue',
      reason: `attachment:ambiguous_image:${signals.join('+')}:${label}`,
    };
  }

  return { action: 'keep' };
}

/** An attachment that should make the attachment extractor claim the email. */
function isArchivableAttachment(att: AttachmentMeta, referencedCids: Set<string>): boolean {
  if (isPdfAttachment(att) || isOfdAttachment(att) || isZipAttachment(att)) return true;
  if (!isImageAttachment(att)) return false;
  return classifyImageAttachment(att, referencedCids).action !== 'discard';
}

function looksLikeItinerary(artifact: PdfArtifact): boolean {
  const text = `${artifact.suggestedName || ''} ${artifact.source}`.toLowerCase();
  return looksLikeItineraryText(text);
}

/**
 * EXT-08：附件在入库前核对 magic bytes；声明类型与真实类型不一致时记 issue 并跳过。
 */
function validateAttachmentBytes(
  data: Buffer,
  claimed: 'pdf' | 'ofd' | 'image',
  label: string,
): { ok: true; format: 'pdf' | 'ofd' | 'image' } | { ok: false; reason: string } {
  const kind = detectDocumentKind(data);
  if (claimed === 'pdf') {
    if (kind === 'pdf') return { ok: true, format: 'pdf' };
    return { ok: false, reason: `attachment:magic_mismatch:${label}:claimed_pdf:got_${kind}` };
  }
  if (claimed === 'ofd') {
    // OFD 是 ZIP 容器（PK 头）。
    if (kind === 'archive') return { ok: true, format: 'ofd' };
    return { ok: false, reason: `attachment:magic_mismatch:${label}:claimed_ofd:got_${kind}` };
  }
  if (kind === 'image') return { ok: true, format: 'image' };
  return { ok: false, reason: `attachment:magic_mismatch:${label}:claimed_image:got_${kind}` };
}

const attachmentExtractor: Extractor = {
  name: 'attachment',

  canHandle(mail: ParsedMail): boolean {
    // Only claim the email when it carries a real document attachment. An email
    // whose only "attachments" are embedded signature logos must fall through to
    // the directLink / thirdParty extractors so its real invoice link is followed.
    const referencedCids = collectReferencedCids(mail);
    return (mail.attachments ?? []).some((att) => isArchivableAttachment(att, referencedCids));
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const pdfs: PdfArtifact[] = [];
    const referencedCids = collectReferencedCids(mail);

    if (!mail.attachments || mail.attachments.length === 0) {
      return { kind: 'manual', reason: 'no_attachments' };
    }

    let totalBytes = 0;
    let skippedOversize = false;
    // 逐条记录被跳过 / 解析失败的附件，即使本封邮件还有其他成功文档，也必须把这些
    // 失败上报给 pipeline，避免“一个小文件 + 一个超限文件”被当成完整成功（APP-01）。
    const issues: ExtractIssue[] = [];
    // Returns false (and marks the skip) when adding `size` bytes would breach
    // the per-document or cumulative per-email cap.
    const admit = (size: number, label: string): boolean => {
      if (size > PER_DOC_CAP) {
        skippedOversize = true;
        issues.push({ reason: `attachment:doc_size_cap_exceeded:${label}` });
        ctx.log.warn(`Skip oversized document ${label}: ${size} > ${PER_DOC_CAP} bytes`);
        return false;
      }
      if (totalBytes + size > PER_EMAIL_CAP) {
        skippedOversize = true;
        issues.push({ reason: `attachment:mail_size_cap_exceeded:${label}` });
        ctx.log.warn(`Skip document ${label}: per-email ${PER_EMAIL_CAP} byte cap exceeded`);
        return false;
      }
      totalBytes += size;
      return true;
    };

    for (const att of mail.attachments) {
      if (isPdfAttachment(att)) {
        const label = att.filename || 'unnamed.pdf';
        const validated = validateAttachmentBytes(att.content, 'pdf', label);
        if (!validated.ok) {
          issues.push({ reason: validated.reason });
          ctx.log.warn(`Skip attachment ${label}: ${validated.reason}`);
          continue;
        }
        if (!admit(att.content.length, label)) continue;
        pdfs.push({
          data: att.content,
          source: label,
          suggestedName: att.filename,
          format: 'pdf',
          documentType: 'invoice',
        });
      } else if (isOfdAttachment(att)) {
        const label = att.filename || 'unnamed.ofd';
        const validated = validateAttachmentBytes(att.content, 'ofd', label);
        if (!validated.ok) {
          issues.push({ reason: validated.reason });
          ctx.log.warn(`Skip attachment ${label}: ${validated.reason}`);
          continue;
        }
        if (!admit(att.content.length, label)) continue;
        pdfs.push({
          data: att.content,
          source: label,
          suggestedName: att.filename,
          format: 'ofd',
          documentType: looksLikeOfdItinerary({ data: att.content, source: label, suggestedName: att.filename, format: 'ofd' })
            ? 'itinerary'
            : 'invoice',
          requiresOcr: true,
        });
      } else if (isZipAttachment(att)) {
        const zipName = att.filename || 'unnamed.zip';
        try {
          // 与站点处理器共用同一个 ZIP 解包器：entry 数量、单条/总解压上限和
          // 压缩比（zip bomb）防护都在其中（APP-09）。
          const { documents, skipped } = documentsFromZip(att.content, zipName);
          for (const item of skipped) {
            skippedOversize = true;
            issues.push({ reason: `attachment:zip_entry_skipped:${item}` });
            ctx.log.warn(`Skipped ZIP entry ${item}`);
          }
          for (const doc of documents) {
            if (!admit(doc.data.length, doc.source)) continue;
            pdfs.push(doc);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          issues.push({ reason: `attachment:zip_failed:${zipName}:${msg}` });
          ctx.log.warn(`Failed to extract ZIP ${zipName}: ${msg}`);
        }
      } else if (isImageAttachment(att)) {
        // EXT-04：仅在组合证据下静默丢弃装饰图；弱信号保留并记 issue。
        const disposition = classifyImageAttachment(att, referencedCids);
        if (disposition.action === 'discard') {
          ctx.log.debug(`Skip decorative image ${att.filename || att.cid || 'inline-image'}`);
          continue;
        }
        if (disposition.action === 'keep_with_issue') {
          issues.push({ reason: disposition.reason });
          ctx.log.warn(`Keep ambiguous image with issue: ${disposition.reason}`);
        }
        const label = att.filename || 'unnamed-image';
        const validated = validateAttachmentBytes(att.content, 'image', label);
        if (!validated.ok) {
          issues.push({ reason: validated.reason });
          ctx.log.warn(`Skip attachment ${label}: ${validated.reason}`);
          continue;
        }
        if (!admit(att.content.length, label)) continue;
        pdfs.push({
          data: att.content,
          source: label,
          suggestedName: att.filename,
          format: 'image',
          documentType: looksLikeItinerary({ data: att.content, source: label, suggestedName: att.filename, format: 'image' })
            ? 'itinerary'
            : 'invoice',
          requiresOcr: true,
        });
      }
    }

    if (pdfs.length === 0) {
      return { kind: 'manual', reason: skippedOversize ? 'doc_size_cap_exceeded' : 'no_supported_documents_in_attachments' };
    }
    if (skippedOversize) {
      ctx.log.warn(`Archived ${pdfs.length} document(s); some attachments were skipped for exceeding the size cap`);
    }

    return {
      kind: 'pdf',
      pdfs: preferPdfOverDuplicateOfd(pdfs, ctx.log, mail.subject ?? undefined),
      issues,
    };
  },
};

export default attachmentExtractor;
