import { createOpenableHandles } from './openableHandles.js';
import path from 'node:path';
import {
  loadAppSummary,
  loadGuiConfig,
  summarizeInbox,
  summarizeLibrary,
  type AppSummary,
} from './summary.js';
import { redactPath, sanitizeText, shortId } from './sanitize.js';

export interface SummaryPageOptions {
  inboxLimit?: number;
  inboxOffset?: number;
  libraryLimit?: number;
  libraryOffset?: number;
}

export interface SummaryFacadeDeps {
  configPath: string;
  dataDir: string;
  bundledConfigPath: string;
  asObject: (value: unknown) => Record<string, unknown>;
  resolveCanonicalPath: (inputPath: string) => string | undefined;
  realDataDir: () => string | undefined;
  isPathSegmentInside: (candidate: string, parent: string) => boolean;
  isInsideOpenPathAllowedRoots: (candidate: string) => boolean;
}

export function createSummaryFacade(deps: SummaryFacadeDeps) {
  const { registerExternalFileHandle, resolveExternalFileHandle } = createOpenableHandles(deps);
  function asSummaryOptions(value: unknown): SummaryPageOptions | undefined {
    const raw = deps.asObject(value);
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    };
    const opts: SummaryPageOptions = {
      inboxLimit: num(raw.inboxLimit),
      inboxOffset: num(raw.inboxOffset),
      libraryLimit: num(raw.libraryLimit),
      libraryOffset: num(raw.libraryOffset),
    };
    return Object.values(opts).some((v) => v !== undefined) ? opts : undefined;
  }

  /**
   * 给 renderer 的可打开引用：dataDir 内用相对路径；配置允许根内用 opaque `ext:` 句柄。
   * 仅当路径当前落在允许根内才签发句柄——禁止 OCR 文件名 traversal 铸造任意 handle。
   * 赎回时仍会按**当前**允许根再校验一次（配置变更后旧 handle 失效）。
   */
  function rendererOpenablePath(abs: string): string {
    if (!abs) return '';
    const canon = deps.resolveCanonicalPath(abs);
    if (!canon) return '';
    if (!deps.isInsideOpenPathAllowedRoots(canon)) return '';
    const base = deps.realDataDir();
    if (base && deps.isPathSegmentInside(canon, base)) {
      const rel = path.relative(base, canon);
      // 拒绝 `..` 逃逸形态的相对串
      if (rel.startsWith('..') || path.isAbsolute(rel)) return registerExternalFileHandle(canon);
      return rel.split(path.sep).join('/') || '.';
    }
    // dataDir 外但在允许根内：opaque 句柄，永不把绝对路径交给 renderer。
    return registerExternalFileHandle(canon);
  }

  /**
   * ELEC-07：摘要进 renderer 前脱敏内部 CSV 路径与原始错误；
   * filePath 改为可打开的安全形态；nested library.ocr 也必须脱敏。
   */
  function sanitizeAppSummary(summary: AppSummary): AppSummary {
    const sanitizeOcrSummary = (ocr: AppSummary['library']['ocr']): AppSummary['library']['ocr'] => ({
      ...ocr,
      pendingCsv: ocr.pendingCsv ? redactPath(ocr.pendingCsv) : '',
      resultsCsv: ocr.resultsCsv ? redactPath(ocr.resultsCsv) : '',
      byDocumentType: (ocr.byDocumentType ?? []).map((g) => ({
        ...g,
        examples: (g.examples ?? []).map((ex) => ({
          ...ex,
          hash: ex.hash ? shortId(ex.hash) : ex.hash,
          from: ex.from ? sanitizeText(ex.from, { maxLength: 80 }) : ex.from,
          subject: ex.subject ? '<主题已隐藏>' : ex.subject,
          reason: ex.reason ? sanitizeText(ex.reason, { maxLength: 120 }) : ex.reason,
        })),
      })),
      bySupportingReason: (ocr.bySupportingReason ?? []).map((g) => ({
        ...g,
        examples: (g.examples ?? []).map((ex) => ({
          ...ex,
          hash: ex.hash ? shortId(ex.hash) : ex.hash,
          subject: ex.subject ? '<主题已隐藏>' : ex.subject,
          reason: ex.reason ? sanitizeText(ex.reason, { maxLength: 120 }) : ex.reason,
        })),
      })),
      byFailureReason: (ocr.byFailureReason ?? []).map((g) => ({
        ...g,
        key: g.key ? sanitizeText(g.key, { maxLength: 80 }) : g.key,
        examples: (g.examples ?? []).map((ex) => ({
          ...ex,
          hash: ex.hash ? shortId(ex.hash) : ex.hash,
          subject: ex.subject ? '<主题已隐藏>' : ex.subject,
          reason: ex.reason ? sanitizeText(ex.reason, { maxLength: 120 }) : ex.reason,
        })),
      })),
    });

    return {
      ...summary,
      configPath: redactPath(summary.configPath),
      configError: summary.configError ? sanitizeText(summary.configError) : '',
      library: {
        ...summary.library,
        pendingCsv: summary.library.pendingCsv ? redactPath(summary.library.pendingCsv) : '',
        resultsCsv: summary.library.resultsCsv ? redactPath(summary.library.resultsCsv) : '',
        rows: summary.library.rows.map((row) => {
          const fileHandle = row.filePath ? rendererOpenablePath(row.filePath) : '';
          return {
            ...row,
            filePath: fileHandle,
            fileHandle,
            error: row.error ? sanitizeText(row.error, { maxLength: 200 }) : row.error,
          };
        }),
        ocr: sanitizeOcrSummary(summary.library.ocr),
      },
      inbox: {
        ...summary.inbox,
        indexCsv: summary.inbox.indexCsv ? redactPath(summary.inbox.indexCsv) : '',
      },
      pending: {
        ...summary.pending,
        csvPath: summary.pending.csvPath ? redactPath(summary.pending.csvPath) : '',
        groups: summary.pending.groups.map((group) => ({
          ...group,
          rows: group.rows.map((row) => ({
            ...row,
            reason: row.reason ? sanitizeText(row.reason, { maxLength: 200 }) : row.reason,
            machineReason: row.machineReason
              ? sanitizeText(row.machineReason, { maxLength: 200 })
              : row.machineReason,
          })),
        })),
      },
      history: summary.history.map((entry) => ({
        ...entry,
        detail: entry.detail ? sanitizeText(entry.detail, { maxLength: 500 }) : entry.detail,
        message: entry.message ? sanitizeText(entry.message, { maxLength: 200 }) : entry.message,
      })),
    };
  }

  /** 契约 7：分页参数透传给 summary 模块；没有分页参数时保持原行为。 */
  function appSummary(opts?: SummaryPageOptions): AppSummary {
    const base = loadAppSummary(deps.configPath, deps.dataDir, deps.bundledConfigPath);
    if (!opts) return sanitizeAppSummary(base);
    const { cfg } = loadGuiConfig(deps.configPath, deps.bundledConfigPath);
    return sanitizeAppSummary({
      ...base,
      inbox: summarizeInbox(cfg, deps.dataDir, { limit: opts.inboxLimit, offset: opts.inboxOffset }),
      library: summarizeLibrary(cfg, deps.dataDir, { limit: opts.libraryLimit, offset: opts.libraryOffset }),
    });
  }

  return {
    issueOpenableHandle: rendererOpenablePath,
    asSummaryOptions,
    sanitizeAppSummary,
    appSummary,
    resolveExternalFileHandle,
  };
}

export type SummaryFacade = ReturnType<typeof createSummaryFacade>;
