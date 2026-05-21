import type { ParsedMail } from 'mailparser';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Ctx, Extractor, ExtractResult, PdfArtifact } from './types.js';

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
  return /行程单|行程报销|航空运输电子客票|客票|机票|航班|itinerary|e-ticket|eticket/.test(text);
}

function subjectLooksLikeItinerary(subject: string | undefined): boolean {
  return /行程单|行程报销|航空运输电子客票|客票|机票|航班|itinerary|e-ticket|eticket/i.test(subject || '');
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

    if (looksLikeItinerary(artifact)) {
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

    for (const att of mail.attachments) {
      if (isPdfAttachment(att)) {
        pdfs.push({
          data: att.content,
          source: att.filename || 'unnamed.pdf',
          suggestedName: att.filename,
          format: 'pdf',
          documentType: 'invoice',
        });
      } else if (isOfdAttachment(att)) {
        pdfs.push({
          data: att.content,
          source: att.filename || 'unnamed.ofd',
          suggestedName: att.filename,
          format: 'ofd',
          documentType: looksLikeItinerary({ data: att.content, source: att.filename || 'unnamed.ofd', suggestedName: att.filename, format: 'ofd' })
            ? 'itinerary'
            : 'invoice',
          requiresOcr: true,
        });
      } else if (isZipAttachment(att)) {
        try {
          const zip = new AdmZip(att.content);
          const entries = zip.getEntries();
          for (const entry of entries) {
            if (entry.isDirectory) continue;
            const entryName = entry.name.toLowerCase();
            if (!entryName.endsWith('.pdf') && !entryName.endsWith('.ofd')) continue;

            const content = entry.getData();
            const isOfd = entryName.endsWith('.ofd');
            pdfs.push({
              data: content,
              source: `${att.filename || 'unnamed.zip'}/${entry.name}`,
              suggestedName: entry.name,
              format: isOfd ? 'ofd' : 'pdf',
              documentType: isOfd && looksLikeItinerary({
                data: content,
                source: `${att.filename || 'unnamed.zip'}/${entry.name}`,
                suggestedName: entry.name,
                format: 'ofd',
              }) ? 'itinerary' : 'invoice',
              requiresOcr: isOfd,
            });
          }
        } catch (err) {
          ctx.log.warn(`Failed to extract ZIP ${att.filename}: ${err}`);
        }
      }
    }

    if (pdfs.length === 0) {
      return { kind: 'manual', reason: 'no_supported_documents_in_attachments' };
    }

    return { kind: 'pdf', pdfs: preferPdfOverDuplicateOfd(pdfs, ctx.log, mail.subject) };
  },
};

export default attachmentExtractor;
