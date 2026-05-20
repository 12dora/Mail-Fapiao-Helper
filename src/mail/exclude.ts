export interface MailHeaderLike {
  from: string;
  subject: string;
}

export function nonInvoiceReason(mail: MailHeaderLike): string | null {
  const from = mail.from.toLowerCase();
  const subject = mail.subject;

  if (subject.includes('信用卡') && subject.includes('电子账单')) {
    return 'non_invoice:credit_card_statement';
  }

  if (from.includes('12306@rails.com.cn')) {
    if (subject === '网上购票系统-用户支付通知') {
      return 'non_invoice:12306_payment_notice';
    }
    if (subject === '网上购票系统-用户改签通知') {
      return 'non_invoice:12306_change_notice';
    }
  }

  return null;
}
