import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { Page } from 'playwright';

export interface SiteHandler {
  name: string;
  match(url: string): boolean;
  handle(page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]>;
}
