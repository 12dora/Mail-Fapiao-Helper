import AdmZip from 'adm-zip';
import type { Ctx, PdfArtifact } from '../extract/types.js';

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function filenameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last && last.toLowerCase().endsWith('.pdf')) return decodeURIComponent(last);
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

export async function fetchBuffer(url: string, ctx: Ctx, referer?: string): Promise<{ data: Buffer; contentType: string; contentDisposition: string }> {
  const response = await ctx.http(url, {
    redirect: 'follow',
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
    data: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? '',
    contentDisposition: response.headers.get('content-disposition') ?? '',
  };
}

export function pdfsFromZip(data: Buffer, source: string): PdfArtifact[] {
  const zip = new AdmZip(data);
  const pdfs: PdfArtifact[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.pdf')) continue;
    pdfs.push({
      data: entry.getData(),
      source: `${source}/${entry.name}`,
      suggestedName: safeFilename(entry.name.split('/').pop() || entry.name, 'invoice.pdf'),
    });
  }
  return pdfs;
}
