# 用户可见文案 / 字符串审查报告
审查日期：2026-07-29 ｜ 审查范围：`gui-design/index.html`、`gui-design/pages/{dashboard,inbox,library,pending,config,settings}.html`、`gui-design/scripts/shell.js`、`src/electron/{main,summary,manualArchive,opCoordinator,sanitize}.ts`、`src/{index,pipeline,log,config}.ts`、`src/ocr/{efapiao,registry,runner,summary,types}.ts`、`src/download/{archiveJournal,downloader}.ts`；为验证传播链另读 `src/pending/summary.ts`、`src/util/dataDirLock.ts`、`src/extract/{types,classify}.ts`、`config.example.json` 及既有基线 `docs/CODE_REVIEW_FINDINGS_2026-07-27.md`

## 摘要

当前界面已经补上大部分云端上传说明、危险重置确认和错误详情折叠，较 2026-07-27 基线明显改善。
最严重的问题不是措辞风格，而是文案与真实结果不一致：单封邮件处理失败后，最终仍显示绿色“处理完成”。
第二个高风险点是配置修复：旧配置备份失败时，界面仍承诺“已另存为备份”。
第三个高风险点是发票库统计契约混乱：总数被称为“待识别”，全部待识别又被称为“堂食明细”，失败统计与筛选口径也不同。
待确认恢复流程同样存在错误成功状态：未打开原邮件、未移除待确认记录时，界面仍会宣称成功并隐藏记录。
此前 `COPY-01/02/04/05/06` 仍有残留，主要是原始 CLI 日志、隐私摘要遗漏、重置标题、诊断 CSV 和技术配置。
建议先修复结构化结果与状态码，再统一文案；只替换字符串无法消除前 6 项错误成功/错误统计。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| COPY-01 | P1 | 单封邮件失败后仍提示“处理完成” | `src/index.ts:917-925`；`src/electron/main.ts:1820-1827` |
| COPY-02 | P1 | 配置未备份成功仍承诺“已另存为备份” | `src/electron/main.ts:352-358,388`；`gui-design/scripts/shell.js:2505-2513` |
| COPY-03 | P1 | 发票库统计卡和筛选口径同时失真 | `gui-design/pages/library.html:25-43,94-99`；`src/electron/summary.ts:231-235,315-319` |
| COPY-04 | P1 | 待确认记录未移除，界面却隐藏卡片并报成功 | `src/electron/manualArchive.ts:403-423`；`gui-design/scripts/shell.js:2693-2701` |
| COPY-05 | P1 | 未打开原始邮件时仍显示“已打开原始邮件” | `src/electron/main.ts:2226-2248`；`gui-design/scripts/shell.js:2645-2654` |
| COPY-06 | P1 | 原始 CLI、提取器名和异常栈仍进入普通进度日志 | `src/electron/main.ts:717-727,772-811`；`gui-design/scripts/shell.js:1128-1129,1206-1207` |
| COPY-07 | P1 | “没有待识别文件”的指引遗漏必要步骤 | `src/electron/main.ts:1144-1150,1846-1869`；`src/pipeline.ts:646-674` |
| COPY-08 | P1 | “删除所有本机数据”与实际保留范围矛盾 | `gui-design/pages/config.html:330-339`；`src/electron/main.ts:2352-2379` |
| COPY-09 | P1 | 云端识别隐私摘要漏报行程单上传 | `gui-design/pages/settings.html:82-87` |
| COPY-10 | P1 | 阻断性错误使用内部存储术语，且没有可执行动作 | `src/electron/main.ts:1026-1053,1253-1258,1913-1919` |
| COPY-11 | P2 | 字段错误原样显示 `config.*`、布尔值和内部枚举 | `src/config.ts:212-251,287-297,342-366`；`gui-design/scripts/shell.js:2354-2397` |
| COPY-12 | P2 | 待确认页无条件断言“多数链接过期”或“全部完成” | `gui-design/pages/pending.html:31-36,63-64` |
| COPY-13 | P2 | 普通“复制为 CSV”默认导出支持编号和机器原因 | `gui-design/pages/pending.html:38-40`；`gui-design/scripts/shell.js:2771-2790` |
| COPY-14 | P2 | 首次设置和高级设置要求用户理解协议与服务拓扑 | `gui-design/pages/config.html:46-71,196-209,276-324` |
| COPY-15 | P2 | 命名模板和保存位置暴露 token、hash、相对路径及开发用途 | `gui-design/pages/config.html:99-114,223-271`；`gui-design/pages/settings.html:45-65` |
| COPY-16 | P2 | 页面名和核心动作术语系统性不一致 | `gui-design/scripts/shell.js:31-52`；`gui-design/pages/inbox.html:84-85` |
| COPY-17 | P2 | “来源”列实际显示识别传输方式，并把远程地址称为本机 | `src/electron/summary.ts:241-249`；`gui-design/scripts/shell.js:870-874` |
| COPY-18 | P2 | 文件已存在被报作“归档失败” | `src/electron/manualArchive.ts:300-308`；`gui-design/scripts/shell.js:2697-2701` |

## 详细发现

### COPY-01 单封邮件失败后仍提示“处理完成”

- 严重度：P1
- 位置：`src/index.ts:917-925,951-958`；`src/electron/main.ts:1820-1827`；`gui-design/scripts/shell.js:2267-2271`
- 置信度：CONFIRMED
- 证据：

  ```ts
  failed++;
  log.warn(`Failed to process ${emlPath}: ${err instanceof Error ? err.message : String(err)}`);
  ```

  ```ts
  return 0;
  ```

  ```ts
  message: result.code === 0
    ? `处理完成，本次处理 ${batch.total} 封邮件。`
    : '处理缓存邮件失败，请查看诊断信息后重试。',
  ```

- 问题：普通单封异常只增加 `failed`，CLI 仍退出 0；Electron 仅按退出码返回 `ok: true`，renderer 随后使用成功标题和绿色样式。进度区虽然短暂显示失败数，最终主反馈却说“处理完成”，而 `batch` 只包含 `processed/manual`，失败邮件也未进入待确认。这会让用户把不完整批次当成已完成批次。
- 处置：**改写**，并修正结构化结果，不能只换一句话。
- 建议修复：把 `failed/partial` 写入 IPC 结果；只在两者都为 0 时使用成功态。失败时改为：`已处理 X 封邮件，其中 Y 封没有完成。请点击“重新获取”；如仍失败，请展开“查看技术详情”并联系支持人员。`
- 既有问题：新发现。

### COPY-02 配置未备份成功仍承诺“已另存为备份”

- 严重度：P1
- 位置：`src/electron/main.ts:352-358,388`；`gui-design/scripts/shell.js:2505-2513`
- 置信度：CONFIRMED
- 证据：

  ```ts
  try {
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backup);
    backupPath = redactPath(backup);
  } catch {
    backupPath = undefined;
  }
  ```

  ```ts
  return { ok: true, configPath, config: redactConfig(candidate), ...(backupPath ? { repairedFrom: backupPath } : {}) };
  ```

  ```js
  const backupPath = result?.backupPath || result?.configError?.backupPath || '';
  : '已用当前填写的内容重新生成配置，损坏的旧文件已另存为备份。',
  ```

- 问题：复制旧配置失败后仍继续重建；renderer 不仅没有识别失败，还读取了后端从未返回的 `backupPath` 字段，并在空值分支固定承诺“已另存为备份”。该承诺会让用户错误地把旧授权码和路径视为仍可恢复。
- 处置：**改写**，同时统一 IPC 字段。
- 建议修复：返回 `backupCreated` 与 `backupPath`。成功时显示 `设置已重建，旧设置已另存为备份。`；失败时显示 `设置已重建，但旧设置未能备份。请立即核对邮箱账号、保存位置和识别设置。`
- 既有问题：新发现。

### COPY-03 发票库统计卡和筛选口径同时失真

- 严重度：P1
- 位置：`gui-design/pages/library.html:25-43,94-99`；`gui-design/pages/dashboard.html:35-38`；`src/electron/summary.ts:231-235,315-319`；`src/ocr/summary.ts:122-136`；`gui-design/scripts/shell.js:1500-1505,1527-1533`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="stat__label">待识别文件</div>
  <div class="stat__value" data-lib="total">0</div>
  <span class="small muted">结账单/堂食明细</span>
  <span class="mono strong" data-lib="pending">0</span>
  ```

  ```html
  <div class="stat__label">未识别</div>
  <div class="stat__value" style="color: var(--err-text);" data-dash="failed">0</div>
  ```

  ```ts
  total: Math.max(ocr.total, archivedTotal, rows.length),
  failed: ocr.failed,
  pending: Math.max(ocr.pending, pendingRows),
  ```

  ```js
  if (activeTab === 'partial' && status !== STATUS.PARTIAL) return false;
  if (activeTab === 'failed' && status !== STATUS.FAILED) return false;
  ```

- 问题：`total` 是发票库全部记录，却标为“待识别文件”；`pending` 是全部待识别文件，却标为“结账单/堂食明细”；首页“未识别”只绑定 `failed`。此外，OCR 汇总把 `partial` 计入 `failed`，列表却把它映射为“待补充”，所以失败统计和“识别失败”筛选无法对上。这些都是确定的错误结果，不是措辞偏好。
- 处置：**删除并改写**错误卡片，同时统一状态契约。
- 建议修复：`total` 卡改为 `全部文件`；删除“结账单/堂食明细”卡，或改为绑定 `pending` 的 `等待识别`；首页改为 `识别失败`。将 `partial` 统一称为 `信息不完整` 并独立计数、筛选；若继续计入失败，则“识别失败”筛选必须包含它。
- 既有问题：新发现。

### COPY-04 待确认记录未移除，界面却隐藏卡片并报成功

- 严重度：P1
- 位置：`src/electron/manualArchive.ts:403-423`；`src/electron/main.ts:2319-2327`；`gui-design/scripts/shell.js:2693-2701`
- 置信度：CONFIRMED
- 证据：

  ```ts
  message: '文件已归档并加入识别队列，但待确认记录没有移除，可稍后手动忽略。',
  ```

  ```js
  const removed = result?.ok && !emptied
      ? removePendingRowInPlace(hash, '已归档并移出待确认队列')
      : false;
  ```

  ```js
  result?.ok ? '已归档' : '归档失败',
  ```

- 问题：后端明确返回 `pendingRemoved: 0` 和“记录没有移除”，但 renderer 只看 `ok`，立即从页面移除卡片并用成功标题。当前卡片也没有事后“手动忽略”入口。用户刷新后会看到记录重新出现，且无法判断文件是否重复归档。
- 处置：**改写**，并让 UI 依据 `pendingRemoved` 决定是否隐藏。
- 建议修复：仅当 `pendingRemoved > 0` 时显示 `文件已保存，并已从“待确认”移除。`；否则保留卡片并显示 `文件已保存，并会在下次识别时处理；但这封邮件仍在“待确认”中。请刷新列表后重试移除。`
- 既有问题：新发现。

### COPY-05 未打开原始邮件时仍显示“已打开原始邮件”

- 严重度：P1
- 位置：`src/electron/main.ts:2226-2248`；`gui-design/scripts/shell.js:1564-1570,2645-2654`
- 置信度：CONFIRMED
- 证据：

  ```ts
  return {
    ok: !error,
    code: row ? 'pending_mail_missing_local_copy' : 'pending_row_not_found',
    message: row
      ? '没有找到本地副本，已打开邮件缓存目录，请手动查找原始邮件并刷新链接。'
      : '没有找到对应邮件。',
  };
  ```

  ```js
  showToast(
      result?.ok ? '已打开原始邮件' : '没有找到原始邮件',
      eventMessage(result) || (result?.ok ? '请在邮件里重新获取下载链接后再回来重试。' : '本机缓存里找不到这封邮件，可以先刷新列表。'),
  );
  ```

- 问题：打开备用文件夹成功时 `ok` 也是 `true`；甚至待确认行不存在、但文件夹打开成功时，标题仍是“已打开原始邮件”，与正文“没有找到对应邮件”冲突。`刷新链接` 这个分类名也暗示应用会刷新授权，实际只打开文件或文件夹。
- 处置：**改写**，按 `code` 映射标题和下一步。
- 建议修复：分别使用 `已打开原始邮件`、`已打开已保存邮件文件夹`、`没有找到这封邮件`。分类 `刷新链接` 改为 `链接已过期`；成功打开邮件后的指引改为：`请到开票平台重新下载发票，然后回到这里选择文件归档。`
- 既有问题：新发现。

### COPY-06 原始 CLI、提取器名和异常栈仍进入普通进度日志

- 严重度：P1
- 位置：`src/log.ts:10-12`；`src/index.ts:810,907,1239-1244`；`src/pipeline.ts:456-462,546-561,695-707`；`src/electron/main.ts:717-727,772-811`；`gui-design/scripts/shell.js:1128-1129,1206-1207`
- 置信度：CONFIRMED
- 证据：

  ```ts
  log.info(`Queued ${emlPaths.length} cached emails with concurrency=${workerCount}`);
  ctx.log.warn(`Extractor ${extractor.name} failed for ${hash}: ${msg}`);
  log.info(`No extractor matched ${hash}, -> manual`);
  ```

  ```ts
  emit({
    code: 'files_log',
    message: logText(text),
  });
  ```

  ```js
  const readable = eventMessage(data);
  appendFileLog(readable, data.kind || '');
  ```

- 问题：未被少数正则识别的 stdout/stderr 行会逐行进入普通“识别日志/获取日志”。`sanitizeText` 只脱敏路径、URL 和 hash，不会把 `Extractor`、`concurrency`、内部 reason、英文异常或 `Error.stack` 变成用户能执行的中文。此前 `COPY-01` 仍然成立。
- 处置：普通日志中**删除**原始行，原文**移到“查看技术详情”**。
- 建议修复：CLI 向 GUI 输出稳定事件码和参数；普通日志只由 renderer 映射。例如 `files_queued` → `准备处理 N 封已保存邮件。`，`extractor_failed` → `一个发票来源暂时无法处理，正在尝试其他方式。`，`manual_required` → `这封邮件暂时无法自动取得发票，已加入“待确认”。`；未识别原始行只写诊断文件。
- 既有问题：此前 `COPY-01` 的确认残留。

### COPY-07 “没有待识别文件”的指引遗漏必要步骤

- 严重度：P1
- 位置：`gui-design/pages/library.html:140-142`；`src/electron/main.ts:1144-1150,1846-1869`；`src/pipeline.ts:570-581,646-674`
- 置信度：CONFIRMED
- 证据：

  ```ts
  if (Number(scanned) === 0)
    return '没有待识别文件。请先抓取邮件，或确认本地缓存里有发票附件。';
  ```

  ```html
  暂无识别结果。请先抓取邮件并运行识别。
  ```

  ```ts
  ocrLines.push(ocrCsvLine({
  ```

  ```ts
  appendCsvBlock(ocrPendingCsvPath, OCR_CSV_HEADER, ocrLines);
  ```

- 问题：OCR 读取的是 pipeline 在“获取发票文件”阶段生成的 `ocr-pending.csv`。仅“获取邮件”或缓存里存在附件并不会把文件放入识别队列；用户按当前提示操作后仍会得到同一错误。静态空状态也跳过了首页三步中的第二步。
- 处置：**改写**。
- 建议修复：统一为 `没有等待识别的文件。请到“开始处理”，先完成“获取邮件”和“获取发票文件”，再开始识别。`
- 既有问题：新发现。

### COPY-08 “删除所有本机数据”与实际保留范围矛盾

- 严重度：P1
- 位置：`gui-design/pages/config.html:330-339`；`gui-design/scripts/shell.js:2596-2614`；`src/electron/main.ts:2352-2379`
- 置信度：CONFIRMED
- 证据：

  ```html
  <h2 class="card__title" style="margin: 0 0 4px;">重置应用数据（将删除所有本机数据）</h2>
  不会删除：本页的邮箱与保存设置。保存在应用目录之外的位置不会被删除。
  ```

  ```ts
  if (!isInsideDataDir(target)) {
    if (fs.existsSync(target)) skippedExternal.push(`${candidate.label}：${redactPath(target)}`);
    continue;
  }
  ```

- 问题：标题和首次确认都说“所有本机数据”，正文与实现却明确保留配置和应用数据目录外的文件。对破坏性操作而言，这会让用户错误判断删除边界。此前 `COPY-04/APP-21` 的详细范围和双重确认已修复，但标题仍与真实行为冲突。
- 处置：**改写**。
- 建议修复：标题改为 `清空应用管理的数据（保留邮箱与保存设置）`；正文改为 `会永久删除应用内部保存的邮件、发票和行程单、待确认记录、识别结果及处理记录。邮箱与保存设置不会删除；你另选文件夹中的文件也不会删除。`
- 既有问题：此前 `COPY-04` 的确认残留。

### COPY-09 云端识别隐私摘要漏报行程单上传

- 严重度：P1
- 位置：`gui-design/pages/settings.html:34-39,82-87`；对照 `gui-design/pages/config.html:141-148`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="setting-row__desc">启用后，<strong>待识别的发票文件会被发送到腾讯云</strong>；邮件正文不会发送，密钥只保存在本设备</div>
  ```

- 问题：同一页上方和配置页都明确“发票和行程单文件”会上传，卡片摘要却只说发票。两个隐私说明互相矛盾，靠近当前状态的摘要少报了一类上传文件。
- 处置：**改写**。
- 建议修复：`启用后，待识别的发票和行程单文件会被发送到腾讯云；邮件正文不会发送，密钥只保存在本设备。`
- 既有问题：此前 `COPY-02` 已大体修复后的局部残留。

### COPY-10 阻断性错误使用内部存储术语，且没有可执行动作

- 严重度：P1
- 位置：`src/electron/main.ts:1026-1053,1253-1258,1913-1919`；`src/util/dataDirLock.ts:447-461`；`src/electron/opCoordinator.ts:108-115`
- 置信度：CONFIRMED
- 证据：

  ```ts
  message: '发现未完成的归档恢复，暂时不能写入发票台账。请确认数据目录可写后重试。',
  ```

  ```ts
  message: `无法在数据目录上加锁，请确认数据目录可写后重试。原始错误：${(e as Error).message}`,
  ```

  ```ts
  message: '识别失败，请检查识别服务配置后重试。',
  message: '获取发票文件失败，请检查本地邮件缓存后重试。',
  ```

- 问题：`归档恢复/发票台账/数据目录可写/加锁/识别服务配置` 都不是办公室用户能定位的界面对象；锁错误还把原始异常 `.message` 拼进主文案。pipeline 的任何非零退出都被归因于“本地邮件缓存”，会把非缓存原因错误归到缓存。它们会阻断保存或识别，却没有指向具体页面、按钮或恢复动作。
- 处置：主文案**改写**；原始异常**移到“查看技术详情”**。
- 建议修复：
  - 归档恢复：`上次保存发票时中断，当前无法继续。如有表格程序正在打开发票清单，请先关闭，然后重新打开应用再试。`
  - 识别准备：`无法开始识别。请确认磁盘空间充足，并在“邮箱与保存”中重新选择发票保存位置。`
  - 获取失败：`获取发票文件没有完成。请先重试；如果仍失败，请确认发票保存位置可用，再展开“查看技术详情”。`
  - 锁错误主文案：`另一个发票处理任务正在使用这些文件。请等待它完成；如果没有任务在运行，请重新打开应用。`
- 既有问题：此前 `COPY-01/COPY-06` 的残留。

### COPY-11 字段错误原样显示 `config.*`、布尔值和内部枚举

- 严重度：P2
- 位置：`src/config.ts:212-251,287-297,342-366`；`gui-design/scripts/shell.js:2354-2397`
- 置信度：CONFIRMED
- 证据：

  ```ts
  c.add(path, `config.${path} 不能为空。${rangeText(rule)}`);
  c.add(path, `config.${path} 必须是布尔值，合法值：true 或 false`);
  c.add(path, `config.${path} 只能是 ${allowed.join(' / ')} 之一`);
  ```

  ```js
  const message = String(error?.message || '这个值无法保存。');
  note.textContent = message;
  link.textContent = message;
  ```

- 问题：保存配置时，后端 schema 文案会原样显示在字段下方和错误汇总中。用户看到的是 `config.ocr.batchSize`、`true/false`、`auto / cli / serve`，不是界面字段名和可选择的中文值。页面自己的前端校验覆盖了部分常见数字错误，但损坏配置、旧版本值和枚举不兼容仍会走这条传播链。
- 处置：**改写**。
- 建议修复：返回结构化 `{path, rule, min, max, value}`，由 renderer 用字段中文名生成文案。例如 `「同时识别数量」请填写 1–16 的整数。`、`「匹配邮件标题」和「匹配邮件正文」至少选择一项。`；内部枚举只留在技术详情。
- 既有问题：此前 `COPY-06` 的确认残留。

### COPY-12 待确认页无条件断言“多数链接过期”或“全部完成”

- 严重度：P2
- 位置：`gui-design/pages/pending.html:31-36,63-64`；`gui-design/scripts/shell.js:1670-1672`；`src/pending/summary.ts:112-163,166-198`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="strong">这些邮件大多是历史链接过期，继续自动重试通常也无法下载</div>
  ```

  ```html
  所有邮件都已经自动处理完成，这里不需要你做任何事。
  ```

- 问题：待确认原因还包括临时网络失败、没有直接下载文件、附件格式不支持和通用人工确认；非空队列不能推出“大多链接过期”。首次启动或尚未获取邮件时队列同样为空，因此空队列也不能推出“所有邮件已完成”。
- 处置：**改写**。
- 建议修复：非空提示改为 `这些邮件需要你确认后才能继续。请按每封邮件下方的提示处理。`；空状态改为 `目前没有需要你确认的邮件。获取发票文件后，如有无法自动处理的邮件，会显示在这里。`
- 既有问题：新发现。

### COPY-13 普通“复制为 CSV”默认导出支持编号和机器原因

- 严重度：P2
- 位置：`gui-design/pages/pending.html:38-40`；`gui-design/scripts/shell.js:2771-2790`
- 置信度：CONFIRMED
- 证据：

  ```html
  <button class="btn btn--sm" type="button" data-action="export-table">复制为 CSV</button>
  ```

  ```js
  const lines = [[
      '分组', '下一步', '主题', '日期', '发件人', '原因分类',
      '支持编号', '诊断原因（已脱敏）'
  ].map(csvField).join(',')];
  ```

  ```js
  supportRef(row.hash),
  sanitizeText(row.reason || ''),
  ```

- 问题：卡片内的支持编号和机器原因已正确放进折叠的“诊断信息”，但普通“复制为 CSV”又默认把它们复制到剪贴板。用户预期的是报销处理清单，不是内部 reason 和 hash 派生编号；“CSV”本身也不是目标用户熟悉的动作名称。
- 处置：默认导出中**删除**诊断列；技术内容**移到单独的“复制技术详情”**。
- 建议修复：按钮改为 `复制待确认清单（可粘贴到 Excel）`，默认列只保留 `分类、下一步、邮件标题、日期、发件人、原因说明`。另设明确的 `复制技术详情` 操作。
- 既有问题：此前 `COPY-05` 的确认残留。

### COPY-14 首次设置和高级设置要求用户理解协议与服务拓扑

- 严重度：P2
- 位置：`gui-design/pages/config.html:46-71,153-168,196-209,276-324`；`gui-design/pages/dashboard.html:200-215`；`gui-design/pages/library.html:67-74`；`gui-design/scripts/shell.js:527-551`
- 置信度：CONFIRMED
- 证据：

  ```html
  <label class="field__label" for="cfg-imap-host">收件服务器地址</label>
  <div class="field__hint">在邮箱网页版的「IMAP/SMTP 设置」里可以找到。</div>
  <option value="INBOX">INBOX</option>
  <label class="field__label" for="tencent-secret-id">腾讯云 SecretId</label>
  <label class="field__label" for="tencent-secret-key">腾讯云 SecretKey</label>
  ```

  ```html
  <span class="field__label" id="cfg-tls-label">加密连接（TLS）</span>
  <h3 class="card__title">本机识别服务</h3>
  <option value="serve">只使用常驻服务</option>
  <label class="field__label" for="cfg-ocr-port">服务端口</label>
  <div class="field__hint">单位毫秒，100–60000（0.1–60 秒）。</div>
  ```

  ```js
  engineEl.textContent = engineEnabled ? `已启用 · ${ocr.provider || 'efapiao'}` : '未启用（只保存原件）';
  modeEl.textContent = mode === 'disabled' ? '仅本地规则，不调用云端 OCR'
      : mode === 'required' ? '每个文件都调用云端 OCR'
      : '规则优先，必要时调用云端 OCR';
  ```

  ```html
  <label class="sr-only" for="library-ocr-parallel">识别并行数</label>
  <option value="1" selected>1 个并行</option>
  ```

- 问题：邮箱首次设置直接要求理解 `IMAP/SMTP`、`INBOX` 和服务器地址；高级区继续暴露端口、TLS、常驻服务、服务地址、毫秒、`SecretId/SecretKey`、`efapiao`、`OCR` 和“并行数”。即使位于“高级设置”，这些实现术语也没有说明用户何时需要修改、怎样恢复默认值。
- 处置：常用项**改写**；服务拓扑**移到“查看技术详情（仅按技术支持指引修改）”**。
- 建议修复：
  - `收件服务器地址` → `邮箱服务地址`，帮助改为 `请在邮箱网页版中查找“第三方客户端”或“收信设置”；找不到时请查看邮箱帮助中心。`
  - `INBOX` 仅改显示文字为 `收件箱`，内部 value 保持不变。
  - `加密连接（TLS）` → `使用加密连接（推荐）`。
  - `识别并行数` → `同时识别数量`，选项改为 `每次同时识别 1 份（推荐）`。
  - 重试间隔统一按秒展示；provider、服务地址/端口和原始密钥字段名移入技术详情。
- 既有问题：此前 `COPY-06` 的确认残留。

### COPY-15 命名模板和保存位置暴露 token、hash、相对路径及开发用途

- 严重度：P2
- 位置：`gui-design/pages/config.html:99-114,223-271`；`gui-design/pages/settings.html:45-65`；`gui-design/scripts/shell.js:1839-1849`
- 置信度：CONFIRMED
- 证据：

  ```html
  <input class="input input--mono" id="cfg-path-invoices" data-config="paths.invoices" placeholder="./invoices">
  <input class="input input--mono" id="cfg-path-samples" data-config="paths.samples" placeholder="./samples/raw">
  <input class="input input--mono" id="cfg-path-pending" data-config="paths.pending" placeholder="./pending">
  <input class="input input--mono" id="cfg-rename-fallback" data-config="rename.fallback" placeholder="{date}-{messageId}.pdf">
  <span class="template-token">{messageId}<small>邮件编号</small></span>
  <span class="template-token">{hash}<small>防重编号</small></span>
  ```

  ```html
  <div class="setting-row__title">原始邮件缓存</div>
  <div class="setting-row__desc">用于避免开发和日常使用时反复连接邮箱</div>
  <span class="mono small muted" data-settings-path="samples">./samples/raw</span>
  ```

- 问题：普通用户需要选择“销售方、金额、日期”等命名字段，不需要理解 token、`messageId`、hash、`documentType/status/error`。设置页还直接显示 `./samples/raw` 等相对路径，并泄漏“开发”用途；这些路径会被动态配置值覆盖，但仍以原始路径形式展示。
- 处置：内部字段**删除或移到“查看技术详情”**；路径区域**改写**。
- 建议修复：用可点击的中文字段按钮展示 `销售方、金额、开票日期、发票号码、文件格式、原文件名、发件人、邮件标题`，机器 token 只保存在 DOM data 属性；删除 `messageId/hash/status/error` 的普通入口。设置页改为 `已保存的邮件：用于后续获取发票文件，无需再次连接邮箱`，默认只提供“打开/选择文件夹”，真实路径放入技术详情。
- 既有问题：此前 `COPY-06` 的确认残留。

### COPY-16 页面名和核心动作术语系统性不一致

- 严重度：P2
- 位置：`gui-design/scripts/shell.js:31-52,2760-2764`；`gui-design/pages/dashboard.html:6,16-19`；`gui-design/pages/inbox.html:6,17-19,84-85`；`gui-design/pages/pending.html:6,16-19`；`gui-design/pages/config.html:6,16-17`
- 置信度：CONFIRMED
- 证据：

  ```js
  { id: 'dashboard', label: '开始处理', href: 'dashboard.html', icon: 'play' },
  { id: 'pending',   label: '待确认',   href: 'pending.html',   icon: 'pending', badge: '0', badgeKey: 'pending'  },
  { id: 'config',    label: '邮箱与保存', href: 'config.html',    icon: 'config' },
  dashboard: { heading: '运行控制台', title: '运行控制台 · 发票助手' },
  pending:   { heading: '待处理队列', title: '待处理队列 · 发票助手' },
  config:    { heading: '配置',       title: '配置 · 发票助手' },
  ```

  ```html
  <h1 class="toolbar__title" tabindex="-1">运行控制台</h1>
  <h1 class="toolbar__title" tabindex="-1">待处理队列</h1>
  <h1 class="toolbar__title" tabindex="-1">配置</h1>
  <tr><td colspan="7" class="muted">暂无本地缓存邮件。配置邮箱后点击“开始抓取”。</td></tr>
  ```

- 问题：同一页面在导航、标题、面包屑和空状态中分别叫“开始处理/运行控制台/工作流”“待确认/待处理队列/待确认清单”“邮箱与保存/配置/系统”。空状态还让用户点击不存在的“开始抓取”按钮；真实按钮叫“开始获取邮件”。
- 处置：**改写**。
- 建议修复：页面名统一为 `开始处理、邮件记录、发票库、待确认、邮箱与保存、关于`；动作统一为 `获取邮件、获取发票文件、开始识别`。收件箱空状态改为 `还没有已保存的邮件。请到“开始处理”，选择日期后点击“开始获取邮件”。`
- 既有问题：此前部分搜索/快捷键文案已修复；本项为仍存在的术语残留。

### COPY-17 “来源”列实际显示识别传输方式，并把远程地址称为本机

- 严重度：P2
- 位置：`src/electron/summary.ts:241-249`；`src/ocr/efapiao.ts:177-180`；`gui-design/pages/library.html:129-136`；`gui-design/scripts/shell.js:870-874,1537-1544,2812-2822`
- 置信度：CONFIRMED
- 证据：

  ```ts
  source: row.transport === 'http' ? '本机识别' : row.transport || '归档文件',
  ```

  ```ts
  if (cfg.ocr.serviceUrl) return cfg.ocr.serviceUrl.replace(/\/+$/, '');
  ```

  ```js
  function sourceLabel(source) {
      if (source === 'http') return '本机识别';
      if (source === 'cli') return '单次识别';
      return source || '归档文件';
  }
  ```

- 问题：`transport` 表示 OCR 是经 HTTP 还是单次 CLI 调用，不是发票来源。配置允许 `serviceUrl` 指向非本机地址，因此 `http → 本机识别` 也不总是事实。该值同时显示在表格和复制结果里，会让用户误判文件处理位置。
- 处置：普通表格中**删除**该列；如保留则**移到“查看技术详情”**。
- 建议修复：在后端尚无真实邮件/附件/网站来源字段前，删除“来源”列及导出列。若诊断需要，技术详情中改名 `识别调用方式`，并根据解析后的 endpoint 区分 `本机服务/远程服务/单次调用`，不得直接显示 `http/cli`。
- 既有问题：新发现。

### COPY-18 文件已存在被报作“归档失败”

- 严重度：P2
- 位置：`src/electron/manualArchive.ts:286-308`；`src/electron/main.ts:2306-2316`；`gui-design/scripts/shell.js:2697-2701`
- 置信度：CONFIRMED
- 证据：

  ```ts
  return {
    ok: false,
    code: 'manual_archive_all_duplicates',
    message: '选择的文件都已经归档过了，没有新增内容。',
  };
  ```

  ```js
  result?.ok ? '已归档' : '归档失败',
  ```

- 问题：所有文件都已存在是安全的 no-op，不是归档失败；renderer 只看 `ok: false`，用红色“归档失败”覆盖了准确正文。这会把“无需新增”错误呈现为故障。
- 处置：**改写**，并返回可区分的 no-op 状态。
- 建议修复：对 `manual_archive_all_duplicates` 使用中性标题 `无需重复导入`，正文 `这些文件之前已保存，待确认项没有变化。`；不要使用错误样式。
- 既有问题：新发现。

## 明确排除的项（我检查过但认为不是问题）

1. 云端识别的主体披露已经明确写出文件会发送到腾讯云，以及邮件正文、原文和收发件人不会发送：`gui-design/pages/config.html:141-148`、`gui-design/pages/settings.html:34-39`。本报告只保留 `settings.html:85` 漏掉“行程单”的局部残留，不重报旧 `COPY-02` 主问题。
2. 示例配置不再带伪造的邮箱账号、授权码或云密钥，`config.example.json:4-10,46-50` 使用空值；旧 `COPY-03` 已修复。
3. 重置动作已经有两次确认，并明确列出财务原件和不可撤销性：`gui-design/scripts/shell.js:2596-2614`。本报告只报告标题和真实删除边界矛盾，不把确认不足再次计为 finding。
4. 发票库和邮件记录搜索已明确限定“已加载记录”：`gui-design/pages/inbox.html:49-50`、`gui-design/pages/library.html:49-64`；旧 `COPY-07A` 的“全局搜索”错误承诺不再存在。
5. “关于”页的版本和渠道会从 Electron 应用信息动态填充：`src/electron/main.ts:1667-1690`、`gui-design/scripts/shell.js:517-524`；旧 `COPY-07B` 已修复。
6. 待确认卡片的完整机器原因和支持编号目前放在折叠的诊断区：`gui-design/scripts/shell.js:1637-1655`，普通正文优先使用后端的 `userMessage/nextStep`：`src/pending/summary.ts:112-163`。这一本身不是泄漏；问题只在普通 CSV 导出又默认携带诊断列。
7. 普通 toast 的异常详情通过 `<details>` 折叠，并先做脱敏：`gui-design/scripts/shell.js:2899-2900,2952-2968`。因此没有把所有 `detail: err.message` 一概复报；`COPY-10` 只包含被拼入主 `message` 或主文案本身不可执行的路径。
8. `Run complete` 和 `OCR complete` 两条英文汇总行会被 Electron 明确解析成中文结果：`src/electron/main.ts:649-670,750-768`。本报告的 `COPY-06` 只针对没有匹配结构化规则、会落入 `ocr_log/files_log` 的原始行。

## 术语统一表

| 核心概念 | 建议统一用语 | 当前应替换的变体 |
|---|---|---|
| 入口页 | 开始处理 | 运行控制台、工作流、运行 |
| 设置页 | 邮箱与保存 | 配置、系统、本机配置 |
| 拉取邮件 | 获取邮件 | 抓取邮件、开始抓取、本次抓取、重新抓取 |
| 本地邮件副本 | 已保存的邮件 | 本地缓存、邮件缓存、原始邮件缓存、已缓存 |
| 从邮件取得文件 | 获取发票文件 | 下载并归档、获取并整理、处理缓存邮件 |
| 发票文件目录 | 发票保存文件夹 | 归档目录、归档位置、保存位置 |
| 人工处理清单 | 待确认 | 待处理、待处理队列、待确认队列、待确认清单、挂起 |
| OCR 成功 | 识别完成 | 已识别、完整、成功（同一状态内混用） |
| OCR 结果缺字段 | 信息不完整 | partial、待补充、部分成功 |
| OCR 错误 | 识别失败 | 未识别、暂未识别、失败 |
| 同时处理文件数 | 同时识别数量 | 并行数、识别并行数、N 个并行、workers |
| 用户历史 | 处理记录 | 日志、实时日志、运行历史 |
| 调试信息 | 技术详情 | 诊断信息、诊断原因、stderr、原始错误 |
| 文件清单 | 发票清单 | 发票台账、发票清册、识别结果清册、CSV |
| 商户名称 | 销售方 | 开票方 |
| 发票编号 | 发票号码 | 票号 |
| 邮件标题 | 邮件标题 | 主题 |
| 云端隐私范围 | 发票和行程单文件 | 发票文件、票据、单据 |
| 重复文件结果 | 无需重复导入 | 归档失败、没有新增内容 |
