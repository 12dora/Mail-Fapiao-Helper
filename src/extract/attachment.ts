import type { ParsedMail } from 'mailparser';
import AdmZip from 'adm-zip';
import type { Ctx, Extractor, ExtractResult, PdfArtifact } from './types.js';

function isPdfAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType === 'application/pdf') return true;
  if (att.filename && att.filename.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

function isZipAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType === 'application/zip') return true;
  if (att.contentType === 'application/x-zip-compressed') return true;
  if (att.filename && att.filename.toLowerCase().endsWith('.zip')) return true;
  return false;
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
        });
      } else if (isZipAttachment(att)) {
        try {
          const zip = new AdmZip(att.content);
          const entries = zip.getEntries();
          for (const entry of entries) {
            if (!entry.isDirectory && entry.name.toLowerCase().endsWith('.pdf')) {
              const content = entry.getData();
              pdfs.push({
                data: content,
                source: `${att.filename || 'unnamed.zip'}/${entry.name}`,
                suggestedName: entry.name,
              });
            }
          }
        } catch (err) {
          ctx.log.warn(`Failed to extract ZIP ${att.filename}: ${err}`);
        }
      }
    }

    if (pdfs.length === 0) {
      return { kind: 'manual', reason: 'no_pdf_in_attachments' };
    }

    return { kind: 'pdf', pdfs };
  },
};

export default attachmentExtractor;
