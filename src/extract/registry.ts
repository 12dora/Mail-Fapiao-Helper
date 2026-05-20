import type { Extractor } from './types.js';
import attachmentExtractor from './attachment.js';
import directLinkExtractor from './directLink.js';
import thirdPartyExtractor from './thirdParty.js';

export const extractors: Extractor[] = [
  attachmentExtractor,
  directLinkExtractor,
  thirdPartyExtractor,
];
