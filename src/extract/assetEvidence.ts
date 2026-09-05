/**
 * 「这个目标是票面，还是邮件模板自己的物料？」的统一判据（EXT-15）。
 *
 * 开票平台的邮件里除了发票本身，还塞满了自家的展示资源：页眉横幅、下载按钮、
 * 广告位、公众号/小程序二维码、OFD 阅读器安装包……它们和发票**住在同一个域名下**，
 * 于是「host 里有 fapiao/invoice/dzfp 就算发票证据」这条旧规则会把它们全部当成票
 * 归档。实测用户的 392 封邮件里，据此入库的 99 张图片**没有一张**是发票：
 *
 *   www.fapiao.com/static/images/logo.png          平台 logo
 *   ad.efapiao.com/api/affair/mailimg              广告位
 *   dzfppt.oss-cn-beijing.aliyuncs.com/email/img/email_ypgzhewm.png   公众号二维码
 *   tupian.bwfapiao.com/qrcode/202601/…png         付款二维码
 *   img.pdd-fapiao.com/public/ofd_read.zip         OFD 阅读器安装包（还会 404）
 *
 * 因此判据只看**路径**，不看 host。
 */

/**
 * 明确是模板物料 / 工具，不可能是票面的命名特征。
 * 命中即否决，连 20 位发票号都不能翻案——二维码图片的文件名里常常就带着发票号。
 */
const NON_DOCUMENT_ASSET = new RegExp([
  // 版式与按钮
  'logo', 'banner', 'header', 'footer', 'button', 'btn', 'icon', 'avatar',
  'spacer', 'pixel', 'placeholder', 'background', '[_-]bac(?![a-z])',
  'divider', 'arrow',
  // 打点 / 遥测：阿里云 Direct Mail 的 `/trace/v1/report` 就长这样，探测时会被
  // 当成文档，下载时又固定 400，于是把整封邮件挂进待确认。
  'tracking', 'trace', 'telemetry', 'beacon', 'analytics', 'z_stat',
  // 广告与引流
  'advertis', 'promo', 'marketing', '(?:^|[/_-])ads?(?![a-z])', 'mailimg',
  // 二维码 / 公众号 / 小程序
  'qr[_-]?code', 'erweima', '(?:^|[/_-])ewm(?![a-z])', 'gzh', 'xcx', 'miniprogram',
  // 阅读器 / 客户端 / 帮助页
  'reader', 'viewer', 'ofd_read', 'app[_-]?download', 'setup', 'install',
  'guide', 'help', 'faq', 'unsubscribe', 'privacy', 'terms',
  // 社交
  'facebook', 'twitter', 'wechat', 'weixin', 'linkedin', 'instagram',
  // 中文
  '阅读器', '二维码', '公众号', '小程序', '广告',
].join('|'), 'i');

/**
 * 通用静态资源目录。它比上面的词弱：只有在**没有**独立发票号证据时才构成否决，
 * 免得 `/images/26312000001234567890.jpg` 这种真票被目录名误伤。
 */
const GENERIC_ASSET_DIR = /\/(static|assets|images?|img|css|js|fonts?|public)\//i;

/**
 * 20 位发票号。两端必须是非数字：`invoiceNoKey()` 用的是同一条边界规则，
 * 少了它，`17774402928833368857154` 这类 23 位时间戳会被当成发票号。
 */
const INVOICE_NO = /(?:^|\D)\d{20}(?:\D|$)/;

/** 票面语义词。 */
const INVOICE_WORD = /(invoice|fapiao|einvoice|dzfp|fpjf|kpfw|发票|行程单|itinerary|e-?ticket|reimburse|报销)/i;

/**
 * 这段文本（文件名、路径、附件名）看起来是邮件模板自己的物料 / 工具吗？
 * 用于：附件装饰图判定、下载失败是否算「真缺票」。
 */
export function looksLikeEmailChrome(text: string | undefined): boolean {
  if (!text) return false;
  return NON_DOCUMENT_ASSET.test(text);
}

/**
 * 直链图片是否有「真是发票」的独立证据。
 *
 * **只看路径与查询串，不看 host**：开票平台的 CDN 同时供应品牌物料，host 里的
 * `fapiao` / `invoice` / `dzfp` 说明的是「谁家的图」，不是「这是不是票」。
 */
export function linkedImageHasInvoiceEvidence(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const { pathname, search } = parsed;
  if (looksLikeEmailChrome(pathname)) return false;
  const target = `${pathname}${search}`;
  // 独立发票号足以翻过「通用静态目录」这一层弱否决。
  if (INVOICE_NO.test(target)) return true;
  if (GENERIC_ASSET_DIR.test(pathname)) return false;
  return INVOICE_WORD.test(target);
}
