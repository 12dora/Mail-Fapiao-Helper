# Invoice Email Classification Report

**Analysis Date:** 2026-05-20
**Total Emails:** 105

## Summary Statistics

- **Attachment Pattern:** 62 emails (59%)
- **Direct Link Pattern:** 2 emails (1%)
- **Third-Party Platform:** 39 emails (37%)
- **Ambiguous/Edge Cases:** 2 emails (1%)

## Category 1: Attachment Pattern

**Definition:** PDF invoice directly attached to email, no login required.

**Total:** 62 emails

### Top Senders

| Sender | Domain | Count |
|--------|--------|-------|
| 通行费发票通知 | `service@invoice.txffp.com` | 14 |
| 票通 | `kefu@service.vpiaotong.com` | 13 |
| 美团电票平台 | `it_fapiao@meituan.com` | 6 |
| 海底捞 | `jszxfp01@haidilao.com` | 4 |
| 沃尔玛 | `auth@shove.xforceplus.com` | 3 |
| (no name) | `e-invoice@mail.keytop.cn` | 3 |
| 智慧发票服务平台 | `noreply@crestv.cn` | 2 |
| (no name) | `jieshuninvoice@jieshun.cn` | 2 |
| (no name) | `system@email.czb365.com` | 2 |
| Invoice | `invoice.service2@wbstar.com` | 2 |

### Representative Examples

1. **票通** (`kefu@service.vpiaotong.com`)
   - Subject: 您收到一张来自上海汇语餐饮管理有限公司的电子发票【发票金额：147.00】
   - Links in body: 2

2. **通行费发票通知** (`service@invoice.txffp.com`)
   - Subject: 通行费电子发票
   - Links in body: 0

3. **票通** (`kefu@service.vpiaotong.com`)
   - Subject: 您收到一张来自上海易成美盈餐饮服务有限公司的电子发票【发票金额：1359.00】
   - Links in body: 2

4. **美团电票平台** (`it_fapiao@meituan.com`)
   - Subject: 【电子发票】上海茶田餐饮管理有限公司（发票金额：8.10元）
   - Links in body: 1

5. **沃尔玛** (`auth@shove.xforceplus.com`)
   - Subject: 【沃尔玛】电子发票
   - Links in body: 0

## Category 2: Direct Link Pattern

**Definition:** Email contains direct PDF download link, no login or navigation required.

**Total:** 2 emails

### Top Senders

| Sender | Domain | Count |
|--------|--------|-------|
| 平安产险 | `PA_CX@service.pingan.com` | 2 |

### Representative Examples

1. **平安产险** (`PA_CX@service.pingan.com`)
   - Subject: 您的电子发票已生成
   - Links in body: 2

2. **平安产险** (`PA_CX@service.pingan.com`)
   - Subject: 您的电子发票已生成
   - Links in body: 2

## Category 3: Third-Party Platform

**Definition:** Link to third-party invoice platform requiring navigation/login.

**Total:** 39 emails

### Top Senders

| Sender | Domain | Count |
|--------|--------|-------|
| 诺诺网 | `invoice@info.nuonuo.com` | 12 |
| (no name) | `customer.service@plkchina.com` | 10 |
| 兴业银行信用卡中心 | `creditcard@message.cib.com.cn` | 2 |
| (no name) | `12306@rails.com.cn` | 2 |
| (no name) | `eipp@notice.mallcoo.info` | 2 |
| (no name) | `service@vip.ccb.com` | 2 |
| 系统服务 | `yun2@vip.baiwang.com` | 2 |
| 京东JD.com | `customer_service@jd.com` | 2 |
| 阿里发票平台 | `noreply@notice.invoice-mail.taobao.com` | 1 |
| Timscoffeehouse invoice center | `Invoice@store.timschina.com` | 1 |
| 单单计票税云平台 | `invoice1@mail.360ddj.com` | 1 |
| (no name) | `service@fapiao.com.cn` | 1 |
| (no name) | `E-invoice04@dominos.com.cn` | 1 |

### Representative Examples

1. **诺诺网** (`invoice@info.nuonuo.com`)
   - Subject: 您收到一张【很久以前餐饮管理（上海）有限公司】开具的发票【发票号码：26312000001726118566】
   - Has attachment: False, Links: 8

2. **阿里发票平台** (`noreply@notice.invoice-mail.taobao.com`)
   - Subject: 【阿里发票平台】电子发票附件查收
   - Has attachment: False, Links: 7

3. **诺诺网** (`invoice@info.nuonuo.com`)
   - Subject: 您收到一张【上海合胖餐饮有限公司】开具的发票【发票号码：26312000001833364216】
   - Has attachment: False, Links: 8

4. **Timscoffeehouse invoice center** (`Invoice@store.timschina.com`)
   - Subject: 【电子发票】您已收到Tim Hortons电子发票
   - Has attachment: False, Links: 10

5. **诺诺网** (`invoice@info.nuonuo.com`)
   - Subject: 您收到一张【上海红子鸡美食总汇有限公司】开具的发票【发票号码：26312000001898721121】
   - Has attachment: False, Links: 8

6. **兴业银行信用卡中心** (`creditcard@message.cib.com.cn`)
   - Subject: 兴业银行信用卡2026年03月电子账单
   - Has attachment: False, Links: 69

7. **(no name)** (`12306@rails.com.cn`)
   - Subject: 网上购票系统-用户支付通知
   - Has attachment: False, Links: 7

8. **(no name)** (`eipp@notice.mallcoo.info`)
   - Subject: 前滩太古里电子发票
   - Has attachment: False, Links: 1

## Edge Cases / Ambiguous Patterns

**Total:** 2 emails

These emails have neither attachments nor links, requiring manual inspection:

1. **(no name)** (`krystore@service.alibaba.com`)
   - Subject: 发票开票成功通知
   - MessageId: `<1895692245.199131.1776687508386@store-message-66b9755bc9-47...`

2. **电子发票平台** (`bwjf86587000@www.366tax.com`)
   - Subject: 电子发票
   - MessageId: `<187700605.1334.1777255243380@WIN-CL09EQ1U8LG>...`

## Key Findings

### Pattern Distribution

1. **Attachment-based delivery dominates** (59% of emails)
   - Most common for restaurant chains, retail, and toll road invoices
   - Top senders: 通行费发票通知 (14), 票通 (13), 美团电票平台 (6)

2. **Third-party platforms are significant** (37% of emails)
   - Dominated by 诺诺网 (12 emails) and POPEYES platform (10 emails)
   - Also includes bank statements, e-commerce (JD.com), and travel (12306)
   - High link counts (6-69 links) indicate complex navigation

3. **Direct link pattern is rare** (2% of emails)
   - Only 平安产险 (insurance) uses this pattern consistently
   - Suggests most senders prefer attachments or platform-based delivery

### Sender Patterns

**High-volume senders (5+ emails):**

- `service@invoice.txffp.com` (通行费发票通知) - 14 emails, toll road invoices
- `kefu@service.vpiaotong.com` (票通) - 13 emails, restaurant invoices
- `invoice@info.nuonuo.com` (诺诺网) - 12 emails, third-party platform
- `customer.service@plkchina.com` (POPEYES) - 10 emails, third-party platform
- `it_fapiao@meituan.com` (美团电票平台) - 6 emails, restaurant invoices

### Implementation Priorities for Phase 3

1. **Priority 1: Attachment extraction** (62 emails)
   - Implement PDF attachment download and storage
   - Target senders: 通行费, 票通, 美团, 海底捞, 沃尔玛

2. **Priority 2: Third-party platform detection** (39 emails)
   - Detect platform URLs (诺诺网, POPEYES, 阿里发票, 百望云)
   - Extract invoice metadata from email body
   - Flag for manual download (automation requires login credentials)

3. **Priority 3: Direct link extraction** (2 emails)
   - Low volume, but straightforward to implement
   - Test with 平安产险 emails

### Edge Cases Requiring Manual Review

- 2 emails with no attachments or links
- May contain invoice data in email body or require special handling
