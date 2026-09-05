import type { DocumentFormat, PdfArtifact } from './types.js';

interface Classification {
  documentType: 'invoice' | 'itinerary' | 'supporting';
  supportType?: string;
}

function textFor(artifact: PdfArtifact): string {
  return `${artifact.suggestedName || ''} ${artifact.source || ''}`;
}

export function looksLikeItineraryText(value: string | undefined): boolean {
  return /行程单|行程报销|航空运输电子客票|客票|机票|航班|itinerary|e-ticket|eticket/i.test(value || '');
}

export function looksLikeOfdItineraryText(value: string | undefined): boolean {
  return /行程单|航空运输电子客票|itinerary|e-ticket|eticket/i.test(value || '');
}

function supportingTypeForPdf(text: string): string {
  if (/结算单|结算明细|settlement/i.test(text)) return 'settlement';
  if (/通行费电子票据汇总单/.test(text)) return 'toll_summary';
  if (/订单明细|运单明细/.test(text)) return 'order_detail';
  if (/结账单|账单_?\d*/.test(text)) return 'statement';
  if (/堂食明细/.test(text)) return 'meal_detail';
  if (/行程单|行程报销单|car-travel-form|travel-form/i.test(text)) return 'travel_detail';
  return '';
}

export function classifyDocument(artifact: PdfArtifact, format: DocumentFormat): Classification {
  const text = textFor(artifact);
  if (artifact.documentType === 'supporting') {
    return { documentType: 'supporting', supportType: supportingTypeForPdf(text) || 'other' };
  }
  if (!/航空运输电子客票/.test(text)) {
    const supportType = supportingTypeForPdf(text);
    // Generic itineraries retain their existing OFD/image classification.
    if (supportType && (format === 'pdf' || supportType !== 'travel_detail')) {
      return { documentType: 'supporting', supportType };
    }
  }
  if (format === 'ofd') {
    return looksLikeOfdItineraryText(text)
      ? { documentType: 'itinerary' }
      : { documentType: 'invoice' };
  }
  if (format === 'image') {
    return looksLikeItineraryText(text)
      ? { documentType: 'itinerary' }
      : { documentType: 'invoice' };
  }

  // A flight e-ticket itinerary (航空运输电子客票行程单) is a reimbursable document
  // and must reach OCR. It contains "行程单", which supportingTypeForPdf would
  // otherwise classify as a non-reimbursable travel detail, so check it first.
  if (/航空运输电子客票/.test(text)) return { documentType: 'itinerary' };

  const supportType = supportingTypeForPdf(text);
  if (supportType) return { documentType: 'supporting', supportType };
  return { documentType: 'invoice' };
}

export function withDocumentClassification(artifact: PdfArtifact, format: DocumentFormat): PdfArtifact {
  const classification = classifyDocument(artifact, format);
  if (classification.documentType === 'supporting') {
    return {
      ...artifact,
      format,
      documentType: 'supporting',
      requiresOcr: false,
    };
  }
  return {
    ...artifact,
    format,
    documentType: artifact.documentType ?? classification.documentType,
    requiresOcr: true,
  };
}

export function supportingReason(artifact: PdfArtifact): string {
  if (artifact.documentType !== 'supporting') return '';
  const classification = classifyDocument(artifact, artifact.format ?? 'pdf');
  return `supporting_document:${classification.supportType || 'other'}`;
}

/**
 * 整封邮件只归档到「附属材料」——票在半路丢了（EXT-17）。
 *
 * 汇总单、订单明细、结账单、堂食明细本身报销不了，它们只在发票旁边出现。一封邮件
 * 把这些全归档、却一张票都没有，几乎一定是取票那一步失败了；而由于「有产出」，
 * 整封邮件会按 archived 干净收尾，**待确认队列里根本看不到**。
 *
 * 这正是历史上两次静默丢票的形状：
 * - 票根网「包中包」通行费邮件：只留下 `通行费电子票据汇总单(票据/行程).pdf`，
 *   包里 34 张票一张没解出来（10 封邮件）；
 * - 星星充电：只留下 `<发票号>订单明细附件.pdf`，正文里的发票直链没取到。
 *
 * 这里不阻止归档——附属材料该留还是留——只是拒绝把这种结果当成完整成功：
 * 记一条 issue，让 pipeline 按部分成功把邮件挂进待确认，人能看见。
 * 返回 null 表示至少有一份是真票（invoice / itinerary），无需报警。
 */
export function supportingOnlyReason(artifacts: readonly PdfArtifact[]): string | null {
  if (artifacts.length === 0) return null;
  const types = new Set<string>();
  for (const artifact of artifacts) {
    const classification = classifyDocument(artifact, artifact.format ?? 'pdf');
    if (classification.documentType !== 'supporting') return null;
    types.add(classification.supportType || 'other');
  }
  return `only_supporting_documents:${[...types].sort().join('+')}`;
}

/** Historical CSV rows may predate documentType; either signal is sufficient. */
export function isSupportingDocument(row: {
  documentType?: string;
  filename?: string;
  suggestedName?: string;
  source?: string;
  format?: string;
}): boolean {
  if (row.documentType === 'supporting') return true;
  const name = row.suggestedName || row.filename || '';
  const format = row.format || (/\.ofd$/i.test(name) ? 'ofd' : /\.(png|jpe?g|webp)$/i.test(name) ? 'image' : 'pdf');
  return classifyDocument({
    data: Buffer.alloc(0), suggestedName: name, source: row.source || '',
  }, format === 'ofd' || format === 'image' ? format : 'pdf').documentType === 'supporting';
}
