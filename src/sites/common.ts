import AdmZip from 'adm-zip';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import { assertPublicUrl, readCappedBuffer, MAX_DOC_BYTES } from '../util/net.js';

const MAX_ZIP_ENTRIES = 512;

/** decodeURIComponent that never throws on malformed percent-encoding. */
export function tryDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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

export async function fetchBuffer(url: string, ctx: Ctx, referer?: string): Promise<{ data: Buffer; contentType: string; contentDisposition: string }> {
  // SSRF guard: reject non-http(s) and private/loopback targets before fetching.
  await assertPublicUrl(url);
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
    data: await readCappedBuffer(response),
    contentType: response.headers.get('content-type') ?? '',
    contentDisposition: response.headers.get('content-disposition') ?? '',
  };
}

export function pdfsFromZip(data: Buffer, source: string): PdfArtifact[] {
  const zip = new AdmZip(data);
  const pdfs: PdfArtifact[] = [];
  let total = 0;
  let entryCount = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.pdf')) continue;
    if (++entryCount > MAX_ZIP_ENTRIES) break;
    // Guard against decompression bombs using the declared uncompressed size.
    if (entry.header.size > MAX_DOC_BYTES || total + entry.header.size > MAX_DOC_BYTES) continue;
    total += entry.header.size;
    pdfs.push({
      data: entry.getData(),
      source: `${source}/${entry.name}`,
      suggestedName: safeFilename(entry.name.split('/').pop() || entry.name, 'invoice.pdf'),
    });
  }
  return pdfs;
}
