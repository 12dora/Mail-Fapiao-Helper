import type { ParsedMail } from 'mailparser';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Ctx, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { looksLikeItineraryText, looksLikeOfdItineraryText } from './classify.js';
import { MAX_DOC_BYTES } from '../util/net.js';

// Bound how much attachment data one email can pull into memory. A single
// oversized document, an aggregate over the cap, or an archive with an absurd
// entry count degrades to manual instead of risking an OOM (ARCHITECTURE R4).
const PER_DOC_CAP = MAX_DOC_BYTES;
const PER_EMAIL_CAP = MAX_DOC_BYTES;
const MAX_ZIP_ENTRIES = 512;

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

function basename(value: string): string {
  try {
    const parsed = new URL(value);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // Not a URL; fall through to path handling.
  }
  return path.basename(value);
}

function normalizedDocumentKey(artifact: PdfArtifact): string {
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

function invoiceNoKey(artifact: PdfArtifact): string {
  const haystack = `${artifact.suggestedName || ''} ${artifact.source}`;
  const match = haystack.match(/(?:^|\D)(\d{20})(?:\D|$)/);
  return match?.[1] ?? '';
}

function looksLikeItinerary(artifact: PdfArtifact): boolean {
  const text = `${artifact.suggestedName || ''} ${artifact.source}`.toLowerCase();
  return looksLikeItineraryText(text);
}

function looksLikeOfdItinerary(artifact: PdfArtifact): boolean {
  const text = `${artifact.suggestedName || ''} ${artifact.source}`.toLowerCase();
  return looksLikeOfdItineraryText(text);
}

function subjectLooksLikeItinerary(subject: string | undefined): boolean {
  return looksLikeItineraryText(subject);
}

function sameDocument(a: PdfArtifact, b: PdfArtifact): boolean {
  const aNo = invoiceNoKey(a);
  const bNo = invoiceNoKey(b);
  if (aNo && bNo && aNo === bNo) return true;

  const aKey = normalizedDocumentKey(a);
  const bKey = normalizedDocumentKey(b);
  return aKey.length > 0 && aKey === bKey;
}

function preferPdfOverDuplicateOfd(artifacts: PdfArtifact[], log: Ctx['log'], subject: string | undefined): PdfArtifact[] {
  const pdfs = artifacts.filter((item) => (item.format ?? 'pdf') === 'pdf');
  const out: PdfArtifact[] = [];

  for (const artifact of artifacts) {
    if (artifact.format !== 'ofd') {
      out.push(artifact);
      continue;
    }

    if (looksLikeOfdItinerary(artifact)) {
      out.push({ ...artifact, documentType: 'itinerary', requiresOcr: true });
      continue;
    }

    const duplicatePdf = pdfs.find((pdf) => sameDocument(artifact, pdf));
    if (duplicatePdf) {
      log.debug(`Filtered duplicate OFD invoice ${artifact.source}; keeping PDF ${duplicatePdf.source}`);
      continue;
    }

    if (pdfs.length > 0 && !subjectLooksLikeItinerary(subject)) {
      log.debug(`Filtered likely duplicate OFD invoice ${artifact.source}; keeping PDF from same mail`);
      continue;
    }

    out.push({ ...artifact, documentType: 'invoice', requiresOcr: true });
  }

  return out;
}

const attachmentExtractor: Extractor = {
  name: 'attachment',

  canHandle(mail: ParsedMail): boolean {
    return mail.attachments !== undefined && mail.attachments.length > 0;
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const pdfs: PdfArtifact[] = [];

    if (!mail.attachments || mail.attachments.length === 0) {
      return { kind: 'manual', reason: 'no_attachments' };
    }

    let totalBytes = 0;
    let skippedOversize = false;
    // Returns false (and marks the skip) when adding `size` bytes would breach
    // the per-document or cumulative per-email cap.
    const admit = (size: number, label: string): boolean => {
      if (size > PER_DOC_CAP) {
        skippedOversize = true;
        ctx.log.warn(`Skip oversized document ${label}: ${size} > ${PER_DOC_CAP} bytes`);
        return false;
      }
      if (totalBytes + size > PER_EMAIL_CAP) {
        skippedOversize = true;
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
        try {
          const zip = new AdmZip(att.content);
          const entries = zip.getEntries();
          let entryCount = 0;
          for (const entry of entries) {
            if (entry.isDirectory) continue;
            const entryName = entry.name.toLowerCase();
            const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(entryName);
            if (!entryName.endsWith('.pdf') && !entryName.endsWith('.ofd') && !isImage) continue;
            if (++entryCount > MAX_ZIP_ENTRIES) {
              skippedOversize = true;
              ctx.log.warn(`ZIP ${att.filename} exceeds ${MAX_ZIP_ENTRIES} entries; stopping extraction`);
              break;
            }

            const label = `${att.filename || 'unnamed.zip'}/${entry.name}`;
            // Guard against decompression bombs using the DECLARED uncompressed
            // size before ever calling getData() (which allocates the buffer).
            if (!admit(entry.header.size, label)) continue;

            const content = entry.getData();
            const isOfd = entryName.endsWith('.ofd');
            pdfs.push({
              data: content,
              source: `${att.filename || 'unnamed.zip'}/${entry.name}`,
              suggestedName: entry.name,
              format: isImage ? 'image' : (isOfd ? 'ofd' : 'pdf'),
              documentType: isOfd && looksLikeOfdItinerary({
                data: content,
                source: `${att.filename || 'unnamed.zip'}/${entry.name}`,
                suggestedName: entry.name,
                format: 'ofd',
              }) ? 'itinerary' : 'invoice',
              requiresOcr: true,
            });
          }
        } catch (err) {
          ctx.log.warn(`Failed to extract ZIP ${att.filename}: ${err}`);
        }
      } else if (isImageAttachment(att)) {
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

    return { kind: 'pdf', pdfs: preferPdfOverDuplicateOfd(pdfs, ctx.log, mail.subject) };
  },
};

export default attachmentExtractor;
