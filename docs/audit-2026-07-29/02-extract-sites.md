# 发票提取与第三方站点审查报告
审查日期：2026-07-29 ｜ 审查范围：`src/mail/fetcher.ts`、`src/mail/exclude.ts`、`src/extract/*.ts`、`src/sites/*.ts`；调用链交叉核对 `src/pipeline.ts`、`src/index.ts`、`src/download/downloader.ts`、`src/util/net.ts`、`src/util/url.ts`、`src/log.ts`、`src/electron/main.ts`、`gui-design/pages/config.html`、`README.md`、`docs/CODE_REVIEW_FINDINGS_2026-07-27.md`

## 摘要

当前提取链比 2026-07-27 基线明显健康：pipeline 已能组合附件、直链和第三方站点结果，网络请求已有超时/大小限制，中文句末标点、百望短链 host、OFD-only ZIP 等旧问题也已局部修复。
但“局部提取结果如何跨层表达”仍是最危险的边界：通用文件名会把不同发票误判成 PDF/OFD 重复件；直链探测只看前 8 个链接且依赖 `HEAD`；站点处理器又无法表达空结果和 ZIP 部分失败。这三项都能让已发现的发票候选在整封邮件仍显示成功时消失。
附件侧还把所有 `inline` 图片直接当签名图跳过，合法的正文内嵌发票图片没有任何告警。
安全上，旧百望解析接口仍使用明文 HTTP，响应中的下载地址可被链路中间人替换。
此外，严格的 magic-byte 校验只覆盖部分站点，多个直链/站点路径仍会把“声明为 PDF 的 JSON/错误页”归档为成功文件。
建议第一批先修 EXT-01、EXT-02、EXT-03、EXT-04、EXT-06：统一 artifact/issue 返回契约，把去重放到聚合后，并消除明文 HTTP；第二批再统一文档校验、URL 解码和浏览器依赖。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| EXT-01 | P0 | 通用文件名仍会让一张 PDF 删除另一张发票的 OFD | `src/extract/documentIdentity.ts:25-34,48-56,83-88` |
| EXT-02 | P0 | 直链只探测前 8 个链接且只信 `HEAD`，混合邮件会无提示漏票 | `src/extract/directLink.ts:91-105,269-299` |
| EXT-03 | P0 | `SiteHandler` 无法表达空结果/部分失败，站点候选可被当成完整成功 | `src/sites/types.ts:4-7`、`src/extract/thirdParty.ts:103-134` |
| EXT-04 | P0 | 所有 `inline` 图片都被当作签名图无提示丢弃 | `src/extract/attachment.ts:40-58,149-152` |
| EXT-05 | P1 | 32 MiB 原始邮件上限让合法的大附件永远无法进入提取或待确认 | `src/mail/fetcher.ts:15-30`、`src/index.ts:823-827,915-925` |
| EXT-06 | P0 | 旧百望接口用明文 HTTP 获取发票下载地址 | `src/sites/baiwang.ts:100-114` |
| EXT-07 | P1 | PDF/OFD 去重只在单个提取器内部执行，跨来源重复件仍会双重归档 | `src/extract/attachment.ts:173-176`、`src/pipeline.ts:479-485` |
| EXT-08 | P1 | 严格文档响应校验只修了部分站点，其余路径仍信任 MIME/后缀 | `src/extract/directLink.ts:146-150`、`src/sites/jd.ts:21-24` |
| EXT-09 | P1 | 所有站点处理器都被强制依赖浏览器，但当前没有处理器使用页面 | `src/extract/thirdParty.ts:97-99`、`src/sites/types.ts:4-7` |
| EXT-10 | P1 | HTML entity 解码不支持数字实体和大小写形式，查询参数会被截成 fragment | `src/util/url.ts:27-34` |
| EXT-11 | P1 | IMAP 返回项缺少 `source` 时直接静默跳过 | `src/mail/fetcher.ts:198-200` |
| EXT-12 | P2 | 邮件链接扫描仍在两个提取器中整段复制 | `src/extract/directLink.ts:9-31`、`src/extract/thirdParty.ts:9-27` |

## 详细发现

### EXT-01 通用文件名仍会让一张 PDF 删除另一张发票的 OFD

- 严重度：P0
- 位置：`src/extract/documentIdentity.ts:25-34,48-56,83-88`
- 置信度：CONFIRMED
- 证据：
  ```ts
  let name = basename(artifact.suggestedName || artifact.source).toLowerCase();
  ```
  ```ts
  const aKey = normalizedDocumentKey(a);
  const bKey = normalizedDocumentKey(b);
  return aKey.length > 0 && aKey === bKey;
  ```
  ```ts
  const duplicatePdf = pdfs.find((pdf) => sameDocument(artifact, pdf));
  if (duplicatePdf) {
    log.debug(`Filtered duplicate OFD invoice ${artifact.source}; keeping PDF ${duplicatePdf.source}`);
    continue;
  }
  ```
- 问题：这是既有 APP-02 的残留。旧实现“只要存在任意 PDF 就删 OFD”已经修掉，但新实现仍把规范化文件名相同当作可靠身份。两份不同发票分别叫 `invoice.pdf` 和 `invoice.ofd` 时，二者都规范化为 `invoice`，OFD 在内容 hash 计算和 pipeline 聚合之前已经被删除；只有一条 debug 日志，没有 pending、partial 或用户可见的失败状态。
- 建议修复：文件名只能作为弱提示，不能单独触发删除。优先使用可验证的发票号码；没有强身份时同时保留 PDF/OFD，待 OCR 后用结构化字段合并。若必须在 OCR 前去重，至少要求“非通用 stem + 其他独立证据”同时成立，并为 `invoice`、`发票`、`电子发票`、`download` 等通用名设置拒绝列表。

### EXT-02 直链只探测前 8 个链接且只信 `HEAD`，混合邮件会无提示漏票

- 严重度：P0
- 位置：`src/extract/directLink.ts:91-105,269-299`；结果语义核对 `src/pipeline.ts:421-425,470-472,552-568`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const response = await assertPublicResponse(await ctx.http(url, { method: 'HEAD' }));
  const contentType = response.headers.get('content-type');
  return contentType?.includes('application/pdf') ?? false;
  ```
  ```ts
  const probedLinks = probeTargets.slice(0, MAX_PROBE_LINKS);
  ```
  ```ts
  return { kind: 'not_applicable', reason: 'directLink:no_pdf_links' };
  ```
- 问题：没有 `.pdf` 后缀或已知 URL 模式的直链只能靠 `HEAD` 入选。第 9 个及之后的候选根本不请求；对 `HEAD` 返回 405、不给 `Content-Type`、但 `GET` 正常返回 PDF 的服务也会直接判否。若同一邮件还有附件或第三方站点文档，pipeline 会忽略 `not_applicable`，把邮件记为完整成功，因此这个有效直链既不归档也不进入待确认。这说明 APP-01 的组合提取修复仍未覆盖候选探测阶段。
- 建议修复：不要按正文顺序硬截断后直接判“不适用”。先按发票语义、host、锚文本和 URL 参数排序；对 `HEAD` 的 405/无类型响应做带 `Range` 或严格字节上限的 `GET` magic-byte 探测。达到预算仍未检查的候选应返回 `ExtractIssue`，而不是 `not_applicable`；终态至少必须显示部分成功并保留原邮件供用户确认。

### EXT-03 `SiteHandler` 无法表达空结果/部分失败，站点候选可被当成完整成功

- 严重度：P0
- 位置：`src/sites/types.ts:4-7`、`src/sites/nuonuo.ts:137-147`、`src/sites/taobao.ts:29-35`、`src/sites/taobaoFlash.ts:28-34`、`src/extract/thirdParty.ts:103-134`
- 置信度：CONFIRMED
- 证据：
  ```ts
  handle(page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]>;
  ```
  ```ts
  if (!entryUrl) return [];
  ...
  if (!paramList) {
    return [];
  }
  ```
  ```ts
  const { documents, skipped } = documentsFromZip(data, cleanUrl);
  if (skipped.length > 0) {
    ctx.log.warn(`taobao ZIP entries skipped: ${skipped.join(', ')}`);
  }
  if (documents.length > 0) return documents;
  ```
  ```ts
  const first = issues[0];
  return { kind: 'manual', reason: first ? first.reason : 'thirdParty:no_pdfs' };
  ```
- 问题：`SiteHandler` 只能返回 artifact 数组或抛异常，无法表达“这个链接确实匹配，但没有产物”以及“取得部分文档、另一些失败”。诺诺的匹配链接可以返回空数组；当同封邮件另一个站点成功时，空结果不会进入 `issues`。淘宝/淘宝闪购则把 ZIP 中受大小、压缩比、数量或解压错误影响的条目只写日志，仍把成功条目返回；最终 run 汇总会显示完整成功且不会生成 pending。前者可完全无告警漏掉一个站点候选，后者虽有瞬时英文日志，但持久状态仍错误。
- 建议修复：把 `SiteHandler.handle()` 改成与提取器一致的结构化结果，例如 `{ artifacts, issues }`，禁止用 `[]` 表示含糊状态。每个匹配链接必须产生至少一个 artifact 或一条 issue；`documentsFromZip().skipped` 必须逐条上抛。`thirdParty` 汇总所有 handler 的 artifacts/issues，再由 pipeline 形成可持久化的 partial 状态。

### EXT-04 所有 `inline` 图片都被当作签名图无提示丢弃

- 严重度：P0
- 位置：`src/extract/attachment.ts:40-58,149-152`
- 置信度：CONFIRMED
- 证据：
  ```ts
  function isInlineImage(att: AttachmentMeta): boolean {
    if (!isImageAttachment(att)) return false;
    return att.related === true || att.contentDisposition === 'inline';
  }
  ```
  ```ts
  if (isInlineImage(att)) continue;
  ```
- 问题：`inline` 只是 MIME 展示方式，并不证明图片是签名、logo 或 tracking pixel。正文内直接展示的发票扫描件/截图同样会使用 `Content-Disposition: inline`。当前判断不看文件名、尺寸、CID 是否真的被正文引用或像素大小；当邮件同时还有另一份可归档附件时，这张合法图片在循环中直接 `continue`，不产生 issue，邮件会被记为完整成功。
- 建议修复：只自动过滤能被可靠识别为装饰资源的图片，例如 `related=true` 且 CID 确实被 HTML 引用，并结合极小尺寸/文件大小或已知 logo 名称。其余 inline 图片作为 image artifact 保留；无法判定时生成可见 issue，不要静默跳过。

### EXT-05 32 MiB 原始邮件上限让合法的大附件永远无法进入提取或待确认

- 严重度：P1
- 位置：`src/mail/fetcher.ts:15-30`、`src/extract/attachment.ts:8-12`；调用方核对 `src/index.ts:823-827,915-925`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const RAW_MAIL_PARSE_LIMIT = 32 * 1024 * 1024;
  ```
  ```ts
  if (raw.length > RAW_MAIL_PARSE_LIMIT) {
    throw new Error(`mail_too_large_to_parse:${raw.length}>${RAW_MAIL_PARSE_LIMIT}`);
  }
  ```
  ```ts
  const PER_DOC_CAP = MAX_DOC_BYTES;
  const PER_EMAIL_CAP = MAX_DOC_BYTES;
  ```
- 问题：附件层声明单文档/单邮件可到 50 MiB，但 MIME 原始邮件在 32 MiB 就拒绝解析；base64 还会把附件体积扩大约三分之一。因此一个明显小于 50 MiB 的合法 PDF 就能让原始邮件超过 32 MiB。fetch 会按 envelope 缓存该邮件，但 run 再次调用同一 guard，并在进入 `processMail()` 前失败；worker 只增加 `failed`，不会写 pending。重跑永远得到同样结果，用户也没有待确认入口可手动补档。
- 建议修复：统一并明确原始邮件、解码后单附件、邮件累计解码量三种上限。若产品必须保留 32 MiB 原始邮件上限，fetch/run 应为该邮件写入 durable pending，给出“邮件过大，请手动选择发票文件”的中文原因；不要只把它留在运行日志的 failed 计数中。

### EXT-06 旧百望接口用明文 HTTP 获取发票下载地址

- 严重度：P0
- 位置：`src/sites/baiwang.ts:100-114`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const apiUrl = `http://i.baiwang.com/api/forward/tour/invoices?invoiceId=${encodeURIComponent(invoiceId)}`;
  const response = await ctx.http(apiUrl, {
  ```
  ```ts
  const downloadUrl = json.resultData?.find((row) => typeof row.einvoiceUrl === 'string')?.einvoiceUrl;
  ```
- 问题：`invoiceId` 和返回的 `einvoiceUrl` 都经过未加密、未认证的 HTTP 链路。网络中间人既能读取发票标识，也能替换 JSON 中的下载地址；后续校验只能证明替换地址是公网且返回 PDF，不能证明它属于百望或对应原发票，因此恶意 PDF 可以被当成真实发票归档。
- 建议修复：改用受支持的 HTTPS endpoint；若旧接口没有 HTTPS，应停用该自动路径并进入待确认，不应降级到明文。对 API 返回的下载 URL 再做供应商 host allowlist/签名约束，避免“任意公网 PDF”通过。

### EXT-07 PDF/OFD 去重只在单个提取器内部执行，跨来源重复件仍会双重归档

- 严重度：P1
- 位置：`src/extract/attachment.ts:173-176`、`src/extract/directLink.ts:352-357`、`src/extract/thirdParty.ts:119-134`；聚合核对 `src/pipeline.ts:479-485`
- 置信度：CONFIRMED
- 证据：
  ```ts
  pdfs: preferPdfOverDuplicateOfd(pdfs, ctx.log, mail.subject ?? undefined),
  ```
  ```ts
  const key = contentHashOf(artifact.data);
  if (seen.has(key)) continue;
  seen.add(key);
  artifacts.push(artifact);
  ```
- 问题：`preferPdfOverDuplicateOfd()` 分别在 attachment 和 directLink 的局部数组上执行，thirdParty 不执行；pipeline 聚合后只按内容 hash 去重。相同发票的 PDF 与 OFD 字节必然不同，因此“附件 PDF + 站点 OFD”或“直链 PDF + 站点 OFD”会同时归档、同时进入 OCR/台账。上一轮 APP-02 虽修了错误删除，但并没有建立跨来源的文档身份边界。
- 建议修复：先让全部提取器贡献候选，再在 `runExtractors()` 聚合完成后统一做两层去重：精确内容 hash 去重；跨格式只在强身份匹配时合并。去重结果保留来源列表，避免丢失“附件和站点都提供了同一张票”的追溯信息。

### EXT-08 严格文档响应校验只修了部分站点，其余路径仍信任 MIME/后缀

- 严重度：P1
- 位置：`src/sites/common.ts:70-94`、`src/extract/directLink.ts:146-150`、`src/sites/jd.ts:21-24`、`src/sites/keruyun.ts:20-23`、`src/sites/huaweiTravel.ts:81-84`、`src/sites/taxPreview.ts:37-41`、`src/extract/attachment.ts:14-31`、`src/sites/common.ts:126-131`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const kind = detectDocumentKind(opts.data);
  if (allow.includes(kind)) return kind;
  throw new Error(`${opts.label}_no_document:${opts.contentType || 'unknown'}:${kind}`);
  ```
  ```ts
  if (!contentType.includes('pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
    ctx.log.debug(`GET ${url} was not PDF: ${contentType || 'unknown'}`);
    return { rejected: 'not_a_document' };
  }
  ```
  ```ts
  if (!contentType.includes('application/pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`jd_no_pdf:${contentType || 'unknown'}`);
  }
  ```
- 问题：这是既有 APP-10D 的不完整修复。Nuonuo、Pingan、Baiwang 已改用 magic-byte helper，但 directLink、JD、Keruyun、HuaweiTravel、TaxPreview 仍用“MIME 是 PDF 或前 4 字节是 `%PDF`”的条件；只要错误页/JSON 被服务器错误标成 `application/pdf` 就会通过并被归档为成功。反方向上，规范允许 PDF header 位于文件前部而不必正好从第 0 字节开始，`common.ts` 已支持前 1 KiB，重复实现却会拒绝这类文件。附件/ZIP 又只按 MIME 或扩展名分流，连内容校验都没有。
- 建议修复：让所有来源在生成 artifact 前调用同一个 `assertDocumentResponse`/`detectDocumentKind`；附件和 ZIP entry 同样校验 magic，并把后缀与真实类型不一致记录为 issue。删除各 handler 内重复的 MIME 条件，为 PDF、OFD/ZIP、图片分别建立唯一验证入口。

### EXT-09 所有站点处理器都被强制依赖浏览器，但当前没有处理器使用页面

- 严重度：P1
- 位置：`src/extract/thirdParty.ts:97-99,135-137`、`src/sites/types.ts:4-7`；逐项核对 `src/sites/nuonuo.ts:137`、`src/sites/baiwang.ts:133`、`src/sites/taobao.ts:19`、`src/sites/taobaoFlash.ts:19`、`src/sites/jd.ts:19`、`src/sites/keruyun.ts:18`、`src/sites/pingan.ts:50`、`src/sites/huaweiTravel.ts:77`、`src/sites/taxPreview.ts:32`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const page = await ctx.browser().then((browser) => browser.newPage());
  ```
  ```ts
  handle(page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]>;
  ```
  ```ts
  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
  ```
- 问题：thirdParty 在查看命中的是哪个 handler 之前就启动浏览器并创建 page；当前 9 个 handler 全部把参数命名为 `_page`，实际只使用 `ctx.http`。所以未安装 Chrome/Edge 的用户会在任何第三方站点下载前失败，即使该站点只需普通 HTTP；并发邮件还会无意义地创建/关闭多个 page。page 和 browser 的 finally 释放是正确的，问题是资源根本不该被获取。
- 建议修复：从基础 `SiteHandler` 移除强制 `Page` 参数，默认 handler 只接收 URL/ctx；仅真正需要浏览器的处理器声明 `requiresBrowser: true` 或实现独立浏览器接口，调度器按需惰性创建 page。同步修改“所有第三方网站都需要 Chrome/Edge”的用户文案。

### EXT-10 HTML entity 解码不支持数字实体和大小写形式，查询参数会被截成 fragment

- 严重度：P1
- 位置：`src/util/url.ts:27-34`；调用处 `src/extract/directLink.ts:178-187`、`src/extract/thirdParty.ts:29-38`
- 置信度：CONFIRMED
- 证据：
  ```ts
  export function decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
  ```
- 问题：HTML 邮件可以合法地把 `&` 写成 `&#38;`、`&#x26;` 或 `&AMP;`。当前 helper 不解码这些形式；`new URL()` 会把数字实体里的 `#` 当成 fragment 起点，例如 `?a=1&#38;token=abc` 的 `token` 不再属于 query。依赖 `token`、`invoiceId`、`id`、`param` 的 handler 因而无法 match 或解析。若同封邮件另有成功附件，这条损坏链接最终可被当成 `not_applicable`，不会形成 partial。
- 建议修复：使用经过验证的 HTML entity decoder，或至少完整支持十进制/十六进制数字实体及标准大小写形式；应在解析 DOM attribute 后取得浏览器语义上的 href，再交给 URL normalizer。补充含 `&#38;`、`&#x26;`、`&AMP;` 且关键参数位于第二项的用例。

### EXT-11 IMAP 返回项缺少 `source` 时直接静默跳过

- 严重度：P1
- 位置：`src/mail/fetcher.ts:198-200`
- 置信度：NEEDS-RUNTIME-CHECK
- 证据：
  ```ts
  for await (const msg of client.fetch(uids, { source: true, envelope: true, internalDate: true }, { uid: true })) {
    if (!msg.source) continue;
  ```
- 问题：这是 fetch 循环中唯一既不记录 UID、也不抛错、也不生成可恢复记录的邮件级 `continue`。若 IMAPFlow 在服务端部分响应、消息并发删除或异常 MIME fetch 下确实会产出 `source` 为空的 item，该 UID 会从本次抓取结果无声消失，而命令仍可成功结束。静态代码能确认丢弃行为，但当前仓库没有可证明 IMAPFlow 是否保证“请求了 source 就绝不 yield 空 source”的契约。
- 建议修复：至少 `log.warn` 并累计 `fetchFailed`；更稳妥的是对该 UID 单独重取一次，仍为空则让 fetch 以 partial/非零状态结束。确认方式：用可控 IMAP server 返回包含 UID/envelope、缺失 BODY[] literal 的 FETCH 响应，观察 ImapFlow 是 yield 空 `source` 还是直接抛错；若后者有强契约保证，可把分支改成 invariant error 并删除静默 `continue`。

### EXT-12 邮件链接扫描仍在两个提取器中整段复制

- 严重度：P2
- 位置：`src/extract/directLink.ts:9-31,178-187`、`src/extract/thirdParty.ts:9-38`
- 置信度：CONFIRMED
- 证据：
  ```ts
  function extractLinksFromHtml(html: string): string[] {
    const links: string[] = [];
    const hrefRegex = /href=["']([^"']+)["']/gi;
  ```
  ```ts
  function extractLinksFromText(text: string): string[] {
    const links: string[] = [];
    const urlRegex = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
  ```
- 问题：两个文件各自维护相同的 HTML href 正则、纯文本 URL 正则和 ParsedMail 聚合流程，只共享最后一步 normalizer。上一轮 APP-10A 正是两套链接清理规则漂移后产生的真实回归；目前修复只抽出了尾端清理，扫描入口仍需双改。数字 entity、无引号 href、锚文本语义或链接预算策略一旦只改一处，directLink 与 thirdParty 会再次看到不同的候选集。
- 建议修复：在 `src/util/url.ts` 或新的 `src/extract/mailLinks.ts` 提供唯一 `extractMailUrls(mail)`，返回规范化 URL 及来源元数据（HTML href/text、顺序、可选锚文本）。两个提取器只负责按 handler/直链规则分流，不再各自解析邮件正文。

## 明确排除的项（我检查过但认为不是问题）

- 既有 APP-01 的“pipeline 命中首个提取器后 `break`”已经消失：`src/pipeline.ts:445-485` 会运行全部匹配提取器，并按内容 hash 汇总；本报告只保留未跨过候选探测和 `SiteHandler` 契约的残余问题。
- 既有 APP-02 的“邮件里任意 PDF 都删除所有 OFD”已修复：`src/extract/documentIdentity.ts:83-91` 现在要求身份匹配并保留行程单；EXT-01 仅针对仍被错误视为强身份的通用文件名。
- 既有 APP-10A 的中文句末标点问题已修复：`src/util/url.ts:11-25,43-84` 会清理中文行文分隔符和不配对括号；EXT-10 是另一类尚未覆盖的合法 HTML entity。
- 既有 APP-10B 的百望 `www.bwjf.cn`/`fp.bwjf.cn` 判定不一致已修复：`src/sites/baiwang.ts:7-10,138-142` 的 match 和 handle 共用同一 predicate。
- 既有 APP-10C 的 OFD-only ZIP 问题已修复：`src/sites/common.ts:124-131,211-220` 会提取 PDF、OFD 和受支持图片；本报告指出的是部分条目失败没有进入持久状态。
- Nuonuo 与 Pingan 原先相反的 MIME/magic 判断已修复：`src/sites/nuonuo.ts:117-122`、`src/sites/pingan.ts:53-57` 都使用严格字节校验；EXT-08 只报告尚未迁移的其他路径。
- 资源释放主路径完整：`src/extract/thirdParty.ts:135-137` 在 finally 关闭 page，`src/index.ts:941-948` 关闭共享 browser，`src/mail/fetcher.ts:268-274` 释放 mailbox lock 并 logout；没有发现确认的 browser/page/IMAP 泄漏。
- 注册表接线完整：`src/sites/registry.ts:2-22` 注册了本范围内全部 9 个 handler，`src/extract/registry.ts:6-10` 的 3 个 extractor 均在 `src/pipeline.ts:445` 被实际遍历；未发现“已实现但不可达”的站点文件。
