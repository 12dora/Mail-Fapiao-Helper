# Quality gates adoption record

This records the `be3-gates` adoption baseline; `eslint.config.mjs` is the executable source of truth. All enabled rules have error severity.

## Rules and automation

- ESLint 9 flat config covers `src/**/*.ts`, `scripts/**/*.mjs`, `gui-design/tests/**/*.mjs`, and future `gui-design/src/**/*.{ts,tsx}`.
- Limits: 700 code lines per backend file, 120 per function (comments/blanks excluded; IIFEs allowed), complexity 20, depth 4, parameters 6.
- Other errors: warning comments (TODO/FIXME), TypeScript unused variables (underscore arguments ignored), unused private members, prefer-const, strict equality. Implicit coercion is off.
- Backend TypeScript uses project-service type information for await-thenable; renderer sources use syntax-only TypeScript parsing and React Hooks rules-of-hooks/exhaustive-deps.
- Test functions have length/complexity disabled; other rules remain enabled. Two named pre-existing unused test bindings are retained below.
- `test:core` runs lint, tooling checks, build, typecheck, CLI and Electron tests. CI also runs lint before the test step.
- simple-git-hooks runs lint with zero warnings and typecheck. Installation is opt-in with `MFH_INSTALL_GIT_HOOKS=1 npm run postinstall`, disabled in CI; bypass a local commit with `SKIP_SIMPLE_GIT_HOOKS=1`.
- `npm run smells` / `npm run smells -- --json` is an informational zero-dependency lexical report using physical lines; its output states parser limitations.

## File-length baseline

| File | Current code lines | Limit |
| --- | ---: | ---: |
| src/electron/ipc/operationHandlers.ts | 1006 | 1006 |

All other backend files are below 700 after excluding blanks and comments.

## Named function-length baselines

DI factories stay intact per the backend brief §B memory note. The wrapper delegates counting to the ESLint core rule and grants extra lines only to the listed function name within its listed file; neighboring functions still stop at 120.

| File | Function | Current code lines | Limit |
| --- | --- | ---: | ---: |
| src/electron/archiveRecovery.ts | createArchiveRecovery | 369 | 400 |
| src/electron/ocrRerun.ts | createOcrRerun | 308 | 350 |
| src/electron/openPolicy.ts | createOpenPolicy | 491 | 500 |
| src/electron/pathPolicy.ts | createPathPolicy | 261 | 300 |
| src/electron/resetService.ts | createResetService | 289 | 300 |
| src/electron/ipc/mailHandlers.ts | registerMailHandlers | 241 | 250 |
| src/electron/ipc/operationHandlers.ts | registerOperationHandlers | 840 | 840 |
| src/electron/operationSupport.ts | createOperationSupport | 169 | 200 |
| src/electron/summaryFacade.ts | createSummaryFacade | 126 | 126 |
| src/extract/attachment.ts | extract | 133 | 150 |
| src/electron/summary.ts | summarizeLibrary | 133 | 150 |

`installLifecycle` and `createWindowSecurity` need no exception after comments/blanks are excluded. `extract` is existing attachment traversal debt; `summarizeLibrary` belongs to the separately reviewed summary changes.

## Structural baselines

These are per-file ceilings at the current highest violation, not disabled rules.

| File | Complexity | Depth | Parameters | Reason |
| --- | ---: | ---: | ---: | --- |
| scripts/verify-release-artifacts.mjs | 22 | — | — | platform signature validation branches |
| src/cli/args.ts | 22 | — | — | OCR option dispatch |
| src/cli/dedupe.ts | 26 | — | — | newly landed invoice-number dedupe; separate review |
| src/cli/ocr.ts | — | 6 | — | nested OCR command output |
| src/config.ts | 26 | — | — | numeric configuration validation |
| src/electron/cliRunner.ts | 25 | — | 10 | process result/progress plumbing |
| src/electron/ipc/detailHandlers.ts | 49 | 5 | — | newly landed detail IPC; separate review |
| src/electron/ipc/mailHandlers.ts | 31 | — | — | mail open fallbacks and IPC validation |
| src/electron/ipc/operationHandlers.ts | 32 | — | — | operation dispatch and response construction |
| src/electron/ocrRerun.ts | — | 5 | — | journaled OCR restoration |
| src/electron/openPolicy.ts | 37 | — | — | file signature and open-target checks |
| src/electron/operationSupport.ts | — | 5 | — | operation error reporting |
| src/electron/summary.ts | 26 | — | — | newly landed library/inbox aggregation; separate review |
| src/extract/attachment.ts | 36 | 5 | — | attachment classification and traversal |
| src/extract/directLink.ts | 27 | — | — | document response validation |
| src/mail/fetcher.ts | 31 | 6 | — | mail materialization and mailbox iteration |
| src/ocr/efapiao/binary.ts | 24 | — | — | platform-specific OCR environment |
| src/ocr/runner.ts | — | — | 8 | OCR row processing context |
| src/ocr/summary.ts | 51 | — | — | OCR result aggregation |
| src/pipeline/processMail.ts | — | — | 10 | archive ledger context |
| src/sites/common.ts | 25 | — | — | archive entry validation |
| src/util/dataDirLock/acquire.ts | — | 5 | — | lock acquisition retries |
| src/util/dataDirLock/mutex.ts | 21 | — | — | recovery mutex validation |
| src/util/pinnedFetch.ts | 25 | — | 7 | pinned request/redirect context |

Test binding baselines: `gui-design/tests/_shared.mjs` → `readdir`; `gui-design/tests/electron-ipc-fixture.mjs` → `expectNoText`. Only those names are ignored by the unused-variable rule because this task must not modify `gui-design/`.

## Dead code and retained interfaces

Deleted `identityInSet`, `resetResolverProfile`, and `isPackagedRuntime` after whole-repository searches, including dynamic `dist/` test imports. Also removed lint-confirmed unused `rangeText` and `hasMacFinderAliasIndicator`.

Made 47 symbols module-local:

| Module | Symbols |
| --- | --- |
| src/cli/fetch.ts | INDEX_HEADER, INDEX_LEGACY_HEADERS, readIndexMailHashes, appendIndexRow, writeEmlAtomic, openFetchState, processFetchedMail, closeFetchState, monthDir |
| src/cli/lock.ts | canonicalizePath, collectWriteTargets, scopeLockDir |
| src/cli/rebuildState.ts | walkEmls, primaryHashFromLedgerRow, fetchedHashesFromCache, processedHashesFromLedgers, rebuildStateFromDisk |
| src/cli/run.ts | RunAccumulator, RunContext, resolveCachedMailIdentity, queueOversizedMail, shouldSkipMail, processOneMail |
| src/config.ts | ConfigFieldError, ValidateConfigResult, MigrateResult, ConfigVersionTooNewError, ConfigSchemaVersionInvalidError, formatConfigErrors |
| src/log.ts | MFH_TERMINAL_MARKER |
| src/mail/fetcher.ts | MAIL_PARSE_OPTIONS, withinWindow |
| src/ocr/efapiao/result.ts | stringValue |
| src/ocr/runner.ts | OcrRunSummary |
| src/ocr/summary.ts | OcrSummaryExample, OcrSummaryGroup |
| src/ocr/types.ts | OcrStatus |
| src/pipeline/extract.ts | preferPdfOverStrongIdentityOfd |
| src/pipeline/ledger.ts | ArchivedIndex |
| src/state.ts | StateQuarantine, StateStoreOptions |
| src/util/csv.ts | parseCsvLine, writeCsvAtomic, EnsureCsvSchemaOptions |
| src/util/dateRange.ts | DateWindowInput |
| src/util/hash.ts | ResolveMailIdentityInput |
| src/util/identity.ts | artifactKey |

Preserved documentation-referenced `ensureIndexCsv`, `handleEml`, `CONFIG_SCHEMA_VERSION`, `resolveDateWindow`, `StateCorruptionError`, `quarantineCorruptState`, `resolveSinceBound`, and `resolveUntilExclusiveBound`, plus test-facing exports including `contentHash`, `readCsvRows`, and `rewriteCsvRows`. `DedupeReport` and `runDedupe` remain exported.

The OCR pending writer now uses `OCR_CSV_HEADER` without changing output bytes. URL/IP callers already use `net.ts`; remaining direct imports are within the network implementation and are retained to avoid barrel cycles. Hash behavior and data handling are unchanged.

## Copy changes

All 80 per-file old → new entries follow (shared text appears once per affected file). Machine codes are unchanged; diagnostic filenames, mailbox names and configuration errors moved to `detail`. No exact old-text assertions required updates; the smoke-test phrase was preserved.

| File | Old | New |
| --- | --- | --- |
| src/electron/cliRunner.ts | 无法完成识别。请稍后重试；若连续失败，请到「设置」检查识别相关选项，并展开「查看技术详情」。 | 无法完成识别，请稍后重试或在「设置」中检查识别选项。 |
| src/electron/cliRunner.ts | 获取发票文件没有完成。请先重试；若仍失败，请展开「查看技术详情」或检查网络与邮箱设置。 | 未能获取全部发票文件，请重试或检查网络与邮箱设置。 |
| src/electron/openPolicy.ts | 出于安全考虑，不能打开可执行文件或脚本。请在文件管理器中自行处理。 | 无法打开可执行文件或脚本，请在文件管理器中处理。 |
| src/electron/openPolicy.ts | 目标位置不存在，无法打开或在文件夹中显示。请确认路径是否正确，或先在应用内完成抓取/归档。 | 目标位置不存在，请检查保存位置或先获取邮件并归档发票。 |
| src/electron/openPolicy.ts | 出于安全考虑，不能打开 macOS 替身（别名）文件。请打开真实的文档原件。 | 无法打开替身文件，请选择文档原件。 |
| src/electron/openPolicy.ts | 出于安全考虑，不能打开快捷方式或链接文件。请打开真实的文档原件。 | 无法打开快捷方式或链接文件，请选择文档原件。 |
| src/electron/cliProtocol.ts | 没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。 | 没有等待识别的文件，请先在「开始处理」中获取邮件和发票文件。 |
| src/electron/cliProtocol.ts | 识别没有完成：失败 ${current.failed} 个。请稍后重试；若仍失败，请到「设置」检查识别选项。 | 有 ${current.failed} 个文件识别失败，请重试或在「设置」中检查识别选项。 |
| src/electron/cliProtocol.ts | 没有找到这封待处理邮件。请刷新「待确认」列表后再试。 | 没有找到这封待处理邮件，请刷新「待确认」列表后重试。 |
| src/electron/cliProtocol.ts | 已处理 ${current.archived + current.pending} 封邮件，其中 ${current.failed} 封没有完成${pendingNote}${partialNote}。请点击「重新获取」；如仍失败，请展开「查看技术详情」。 | 已处理 ${current.archived + current.pending} 封邮件，其中 ${current.failed} 封未完成${pendingNote}${partialNote}，请点击「重新获取」。 |
| src/electron/cliProtocol.ts | 处理没有完成：失败 ${current.failed} 封。请先重试；如仍失败，请展开「查看技术详情」。 | 有 ${current.failed} 封邮件处理失败，请重试或查看技术详情。 |
| src/electron/cliProtocol.ts | 处理没有完成。请先重试；如仍失败，请展开「查看技术详情」。 | 邮件处理未完成，请重试或查看技术详情。 |
| src/electron/ocrRerun.ts | 重新识别准备失败，且无法自动恢复原有识别结果。请重新打开应用；若仍异常，请勿继续识别并保留备份文件。 | 无法恢复原有识别结果，请保留备份并重新打开应用，确认结果正常后再继续识别。 |
| src/electron/archiveRecovery.ts | 上次保存发票时中断，当前无法继续修改。请先关闭可能占用发票清单的表格程序，然后重试。若仍无法继续，可在「设置」中查看归档恢复状态并确认隔离未解决的恢复记录（隔离前请勿删除文件）。 | 上次归档尚未恢复，请关闭占用发票清单的程序后重试，或在「设置」中查看归档恢复状态。 |
| src/electron/archiveRecovery.ts | 无法读取归档恢复记录（权限或 I/O 错误）。请检查磁盘权限后重试，勿当作「无残留」。 | 无法读取归档恢复记录，请检查磁盘权限后重试。 |
| src/electron/archiveRecovery.ts | 未发现残留恢复记录，但写入门禁仍可能因其他原因阻断。请重试操作。 | 未发现残留恢复记录，请重试以确认能否继续保存。 |
| src/electron/archiveRecovery.ts | 发现 ${presence.names.length} 条未解决的归档恢复记录（可解析 ${parseable.length}，损坏或格式无效 ${corrupt.length}）。可重试自动恢复，或在确认后隔离这些记录以解除写入阻断。 | 发现 ${presence.names.length} 条未解决的归档恢复记录，请重试恢复或确认隔离。 |
| src/electron/archiveRecovery.ts | 已隔离 ${moved} 条归档恢复记录。写入门禁已解除；隔离副本仍保留在数据目录中，请勿删除直至确认发票清单无误。 | 已隔离 ${moved} 条归档恢复记录，可以继续保存发票。 |
| src/electron/archiveRecovery.ts | 已隔离 ${moved} 条归档恢复记录，但有 ${skippedLive.length} 条仍属于正在运行的进程，已跳过且写入门禁未解除。请等待当前任务结束后再试。 | 已隔离 ${moved} 条恢复记录，另有 ${skippedLive.length} 条仍在使用，请等待当前任务结束后重试。 |
| src/electron/archiveRecovery.ts | 隔离归档恢复记录需要明确确认。请先查看状态后再确认操作。 | 请先查看归档恢复状态，再确认隔离操作。 |
| src/electron/archiveRecovery.ts | 无法读取归档恢复记录，已拒绝隔离（权限错误不能当作无残留）。 | 无法读取归档恢复记录，已取消隔离。 |
| src/electron/archiveRecovery.ts | 有 ${skippedLive.length} 条归档恢复记录仍属于正在运行的进程，已拒绝隔离。请等待当前归档/处理任务结束后再试。 | 有 ${skippedLive.length} 条恢复记录仍在使用，请等待当前任务结束后再隔离。 |
| src/electron/manualArchive.ts | 「${path.basename(source)}」是一个压缩包，不是发票文件。请先解压，再选择里面的 PDF 或 OFD 文件。 | 请先解压所选压缩包，再选择其中的 PDF 或 OFD 文件归档。 |
| src/electron/manualArchive.ts | 选择的文件都已经归档过了，没有新增内容。 | 所选文件均已归档，无需重复添加。 |
| src/electron/configService.ts | 无法保存设置。请确认应用有写入权限后重试；若仍失败，请在「邮箱与保存」中检查保存位置。 | 无法保存设置，请在「邮箱与保存」中检查保存位置及写入权限。 |
| src/electron/resetService.ts | 等待确认期间保存位置发生了变化，已取消重置以保护文件。请重新操作。 | 保存位置已变化，重置已取消，请重新操作。 |
| src/electron/resetService.ts | 无界面模式下拒绝清空数据：当前数据目录不是可证明的临时测试目录。 | 无法确认当前数据可安全清空，已取消重置。 |
| src/electron/runSupport.ts | 没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。 | 没有等待识别的文件，请先在「开始处理」中获取邮件和发票文件。 |
| src/electron/runSupport.ts | 没有找到这封待处理邮件。请刷新「待确认」列表后再试。 | 没有找到这封待处理邮件，请刷新「待确认」列表后重试。 |
| src/electron/ipc/mailHandlers.ts | 选择的文件都已经归档过了，没有新增内容。 | 所选文件均已归档，无需重复添加。 |
| src/electron/ipc/mailHandlers.ts | 没有找到原始邮件文件，已打开已保存邮件文件夹，请手动查找后再到开票平台重新下载。 | 未找到原始邮件，已打开邮件保存文件夹供您查找。 |
| src/electron/ipc/mailHandlers.ts | 文件已保存，并会在下次识别时处理；但这封邮件仍在「待确认」中${skipped}。请刷新列表后重试移除。 | 文件已保存并加入识别队列${skipped}，请刷新「待确认」列表后重试移除这封邮件。 |
| src/electron/ipc/operationHandlers.ts | 无法开始识别，且原有识别结果未能自动恢复。请重新打开应用后再试。 | 无法恢复原有识别结果，请重新打开应用后再试。 |
| src/electron/ipc/operationHandlers.ts | 无法开始识别。请稍后重试；若仍失败，请到「设置」检查识别选项。 | 无法开始识别，请稍后重试或在「设置」中检查识别选项。 |
| src/electron/ipc/operationHandlers.ts | 发现 ${pendingTotal} 个待识别文件，正在启动识别。当前并行数：${concurrency}。 | 正在启动识别，共 ${pendingTotal} 个文件，并行数为 ${concurrency}。 |
| src/electron/ipc/operationHandlers.ts | 识别结束后无法可靠处理备份。请重新打开应用；若识别结果异常，请勿继续操作。 | 识别备份处理失败，请重新打开应用并确认结果后再继续操作。 |
| src/electron/ipc/operationHandlers.ts | 路径无效。请使用位置标识打开目录。 | 无法打开该位置，请重新选择目录。 |
| src/electron/ipc/operationHandlers.ts | 单封邮件标识无效，请从待确认列表重新选择。 | 无法确认这封邮件，请从「待确认」列表重新选择。 |
| src/electron/ipc/operationHandlers.ts | 没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。 | 没有等待识别的文件，请先在「开始处理」中获取邮件和发票文件。 |
| src/electron/ipc/operationHandlers.ts | 正在停止识别。本机识别服务可能需要多等几秒才会完全退出。 | 正在停止识别，本机识别服务可能需要几秒才能退出。 |
| src/electron/ipc/operationHandlers.ts | 未知的位置标识。 | 无法识别该位置，请重新选择。 |
| src/electron/ipc/operationHandlers.ts | 请提供 location、handle 或 path。 | 请选择要打开的文件或文件夹。 |
| src/pending/summary.ts | 邮件里的发票下载链接已失效，无法自动获取发票。 | 发票下载链接已失效，无法自动获取。 |
| src/pending/summary.ts | 请到飞猪或对应出行平台重新下载发票，再用「选择文件归档」上传。 | 请从出行平台重新下载发票，再通过「选择文件归档」添加。 |
| src/pending/summary.ts | 发票下载入口还在，但这次没能取回文件。 | 未能下载发票文件。 |
| src/pending/summary.ts | 可以稍后重试；如果仍然失败，请到开票平台下载后手动上传。 | 请稍后重试，或从开票平台下载后手动归档。 |
| src/pending/summary.ts | 请重新登录慧通差旅获取发票，再用「选择文件归档」上传。 | 请从慧通差旅重新下载发票，再通过「选择文件归档」添加。 |
| src/pending/summary.ts | 这封邮件只有开票入口、二维码或网页链接，没有可以直接下载的发票文件。 | 邮件中没有可直接下载的发票文件。 |
| src/pending/summary.ts | 请打开邮件按提示自行开票或下载，再用「选择文件归档」上传。 | 请按邮件提示开票或下载，再通过「选择文件归档」添加。 |
| src/pending/summary.ts | 附件不是可识别的发票格式（PDF、OFD，或包含它们的压缩包）。 | 附件中没有支持的发票文件。 |
| src/pending/summary.ts | 确认这封邮件不含发票后可以忽略；如果确实有发票，请手动上传。 | 请手动归档发票，或在确认邮件不含发票后忽略。 |
| src/pending/summary.ts | 多次尝试后仍然连不上开票网站。 | 多次重试后仍无法连接开票网站。 |
| src/pending/summary.ts | 请打开原始邮件确认发票获取方式，必要时手动上传发票文件。 | 请查看原始邮件，确认获取方式后手动归档发票。 |
| src/electron/configService.ts | 配置文件已损坏，无法保存：${current.message} | 配置文件已损坏，请修复后再保存。 |
| src/electron/ipc/mailHandlers.ts | 邮箱连接正常，但找不到配置的文件夹「${mailbox}」，已临时打开「${fallbackMailbox}」。请在配置中重新选择目标文件夹。 | 邮箱连接正常，但目标文件夹不可用，请在设置中重新选择。 |
| src/electron/cliProtocol.ts | 识别成功：${sanitizeText(parsed[1] ?? '', { maxLength: 120 })} | 文件识别成功。 |
| src/electron/cliProtocol.ts | 识别失败：${sanitizeText(failed[1] ?? '', { maxLength: 120 })} | 文件识别失败，请查看技术详情。 |
| src/electron/manualArchive.ts | 「${path.basename(source)}」是空文件，无法归档。 | 所选文件为空，无法归档。 |
| src/electron/manualArchive.ts | 「${path.basename(source)}」超过 64 MB，无法归档。 | 所选文件超过 64 MB，无法归档。 |
| src/electron/manualArchive.ts | 「${path.basename(source)}」不是支持的发票文件（仅支持 PDF、OFD 和常见图片）。 | 文件格式不受支持，请选择 PDF、OFD 或常见图片。 |
| src/electron/manualArchive.ts | 「${path.basename(source)}」不是一个文件。 | 所选项目不是文件，无法归档。 |
| src/electron/manualArchive.ts | 无法读取「${path.basename(source)}」，请确认文件仍然存在且可访问。 | 无法读取所选文件，请确认文件仍存在且可访问。 |
| src/electron/openPolicy.ts | 已请求在文件管理器中显示该文件。若未看到窗口，请到应用内对应文件夹查找。 | 已请求显示该文件，若未出现窗口，请通过应用内的文件夹入口查找。 |
| src/electron/openPolicy.ts | 已请求在文件管理器中显示该位置。若未看到窗口，请通过应用内的文件夹入口再试。 | 已请求显示该位置，若未出现窗口，请通过应用内的文件夹入口重试。 |
| src/electron/openPolicy.ts | 已请求在文件管理器中显示该应用程序包（不会启动）。若未看到窗口，请手动在访达中查看。 | 已请求在访达中显示该应用程序包，若未出现窗口，请手动查找。 |
| src/electron/openPolicy.ts | 该文件不适合直接打开；已请求在文件管理器中显示。若未看到窗口，请到应用内对应文件夹查找。 | 无法直接打开该文件，已请求在文件管理器中显示。 |
| src/electron/openPolicy.ts | 目标位置不存在，无法打开。请确认它仍然存在。 | 目标位置不存在，无法打开。 |
| src/electron/openPolicy.ts | 目标位置不存在，无法在文件夹中显示。请确认路径是否正确，或先在应用内完成抓取/归档。 | 目标位置不存在，请检查保存位置或先获取邮件并归档发票。 |
| src/electron/runSupport.ts | 已处理 ${counts.archived + counts.pending} 封邮件，其中 ${counts.failed} 封没有完成。请点击「重新获取」；如仍失败，请展开「查看技术详情」。 | 已处理 ${counts.archived + counts.pending} 封邮件，其中 ${counts.failed} 封未完成，请点击「重新获取」。 |
| src/electron/runSupport.ts | 已处理 ${counts.archived + counts.pending} 封邮件${partialNote}。请到「待确认」继续处理。 | 已处理 ${counts.archived + counts.pending} 封邮件${partialNote}，请到「待确认」继续处理。 |
| src/electron/runSupport.ts | 这封邮件没有处理完成。请稍后重试；如仍失败，请展开「查看技术详情」。 | 这封邮件处理未完成，请重试或查看技术详情。 |
| src/electron/runSupport.ts | 处理缓存邮件没有完成。请先重试；如仍失败，请展开「查看技术详情」。 | 已保存邮件处理未完成，请重试或查看技术详情。 |
| src/electron/runSupport.ts | 已重试 ${attempted} 封，${resolved} 封已移出队列，另有 ${counts.failed} 封没有跑完。请稍后再试一次；如仍失败，请展开「查看技术详情」。 | 已重试 ${attempted} 封，${resolved} 封已移出队列，${counts.failed} 封未完成，请稍后重试。 |
| src/electron/runSupport.ts | 全部重试没有完成，待确认队列保持不变。请稍后再试；如仍失败，请展开「查看技术详情」。 | 重试未完成，待确认队列未变，请稍后重试或查看技术详情。 |
| src/electron/runSupport.ts | 操作已完成，但本地列表暂时无法刷新。请点击「刷新列表」。 | 操作已完成，请点击「刷新列表」更新本地列表。 |
| src/electron/opCoordinator.ts | 另一个发票处理任务正在使用这些文件。请等待它完成；如果没有任务在运行，请重新打开应用。 | 文件正被其他任务使用，请等待任务完成或重新打开应用。 |
| src/electron/ipc/operationHandlers.ts | 邮件已保存，但本次列表明细暂时无法展示。请到「邮件记录」查看。 | 邮件已保存，请到「邮件记录」查看明细。 |
| src/electron/ipc/operationHandlers.ts | 邮件已处理，但本次列表明细暂时无法展示。请刷新列表。 | 邮件已处理，请刷新列表查看明细。 |
| src/electron/ipc/operationHandlers.ts | 无法完成识别。请稍后重试；若仍失败，请到「设置」检查识别选项并查看技术详情。 | 无法完成识别，请重试或在「设置」中检查识别选项。 |
| src/electron/ipc/operationHandlers.ts | 目前没有可整理的识别结果。请先抓取邮件并完成识别后再试。 | 没有可整理的识别结果，请先获取邮件并完成识别。 |

## Verification and scope

`npm run lint -- --max-warnings 0`, build, typecheck, CLI regression/integration/summary tests and Electron smoke/IPC/dedupe/detail tests passed. Gate fixtures verify named limits, file limits and IIFE/test behavior; report fixtures cover source scanning.

No changes to `gui-design/`, `src/electron/ipc/detailHandlers.ts`, `src/electron/mailStatus.ts`, `src/cli/dedupe.ts`, `src/electron/summary.ts`, or `docs/archive`. Structural refactoring of these files and the DI factories is intentionally deferred. Browser E2E is outside the requested verification scope.

## Dedupe review follow-up

Recovery plan discovery and validation now use named steps in `dedupeJournal.ts`; CSV pruning, move replay, and journal finalization retain their existing order. `dedupeHandlers.ts` owns dedupe IPC and report parsing/projection and is registered explicitly in `main.ts`. The legacy operation registration and report exports delegate to it so existing tests require no `gui-design/` edits. `openableHandles.ts` owns the shared bounded handle registry, reverse lookup, eviction, and permission revalidation; summary unit coverage continues through the facade. The three affected file/function ceilings above only shrink.
