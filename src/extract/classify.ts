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
  if (/通行费电子票据汇总单/.test(text)) return 'toll_summary';
  if (/订单明细|运单明细/.test(text)) return 'order_detail';
  if (/结账单|账单_?\d*/.test(text)) return 'statement';
  if (/堂食明细/.test(text)) return 'meal_detail';
  if (/行程单|行程报销单|car-travel-form|travel-form/i.test(text)) return 'travel_detail';
  return '';
}

export function classifyDocument(artifact: PdfArtifact, format: DocumentFormat): Classification {
  const text = textFor(artifact);
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
