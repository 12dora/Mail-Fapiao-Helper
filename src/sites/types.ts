import type { Ctx, PdfArtifact } from '../extract/types.js';

export interface SiteHandler {
  name: string;
  match(url: string): boolean;
  handle(page: unknown, url: string, ctx: Ctx): Promise<PdfArtifact[]>;
}
