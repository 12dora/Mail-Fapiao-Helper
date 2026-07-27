import type { ParsedMail } from 'mailparser';
import type { Ctx, ExtractIssue, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { looksLikeItineraryText } from './classify.js';
import { looksLikeOfdItinerary, preferPdfOverDuplicateOfd } from './documentIdentity.js';
import { documentsFromZip } from '../sites/common.js';
import { MAX_DOC_BYTES } from '../util/net.js';

// Bound how much attachment data one email can pull into memory. A single
// oversized document, an aggregate over the cap, or an archive with an absurd
// entry count degrades to manual instead of risking an OOM (ARCHITECTURE R4).
const PER_DOC_CAP = MAX_DOC_BYTES;
const PER_EMAIL_CAP = MAX_DOC_BYTES;

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

type AttachmentMeta = { contentType?: string; filename?: string; related?: boolean; contentDisposition?: string; cid?: string; contentId?: string };

/**
 * True for an image that mailparser reports as embedded in the HTML body
 * (a signature logo / tracking pixel), not a real document. mailparser sets
 * `related=true` on CID-referenced parts and uses an `inline` disposition for
 * embedded content. Archiving these as invoices both pollutes the library and
 * — because the attachment extractor runs first — shadows the directLink /
 * thirdParty extractors so the email's genuine invoice link is never followed.
 */
function isInlineImage(att: AttachmentMeta): boolean {
  if (!isImageAttachment(att)) return false;
  return att.related === true || att.contentDisposition === 'inline';
}

/** An attachment that should make the attachment extractor claim the email. */
function isArchivableAttachment(att: AttachmentMeta): boolean {
  if (isPdfAttachment(att) || isOfdAttachment(att) || isZipAttachment(att)) return true;
  return isImageAttachment(att) && !isInlineImage(att);
}

function looksLikeItinerary(artifact: PdfArtifact): boolean {
  const text = `${artifact.suggestedName || ''} ${artifact.source}`.toLowerCase();
  return looksLikeItineraryText(text);
}

const attachmentExtractor: Extractor = {
  name: 'attachment',

  canHandle(mail: ParsedMail): boolean {
    // Only claim the email when it carries a real document attachment. An email
    // whose only "attachments" are embedded signature logos must fall through to
    // the directLink / thirdParty extractors so its real invoice link is followed.
    return (mail.attachments ?? []).some(isArchivableAttachment);
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const pdfs: PdfArtifact[] = [];

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
        if (!admit(att.content.length, att.filename || 'unnamed.pdf')) continue;
        pdfs.push({
          data: att.content,
          source: att.filename || 'unnamed.pdf',
          suggestedName: att.filename,
          format: 'pdf',
          documentType: 'invoice',
        });
      } else if (isOfdAttachment(att)) {
        if (!admit(att.content.length, att.filename || 'unnamed.ofd')) continue;
        pdfs.push({
          data: att.content,
          source: att.filename || 'unnamed.ofd',
          suggestedName: att.filename,
          format: 'ofd',
          documentType: looksLikeOfdItinerary({ data: att.content, source: att.filename || 'unnamed.ofd', suggestedName: att.filename, format: 'ofd' })
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
        // Skip signature logos / embedded images; only real image attachments archive.
        if (isInlineImage(att)) continue;
        if (!admit(att.content.length, att.filename || 'unnamed-image')) continue;
        pdfs.push({
          data: att.content,
          source: att.filename || 'unnamed-image',
          suggestedName: att.filename,
          format: 'image',
          documentType: looksLikeItinerary({ data: att.content, source: att.filename || 'unnamed-image', suggestedName: att.filename, format: 'image' })
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
