export interface DateRangePayload {
  from?: string;
  to?: string;
  dryRun?: boolean;
  matchSubject?: boolean;
  matchBody?: boolean;
}

/** 主进程 `mfh:run-ocr` 入参。渲染层同名字段由前端工程师同步。 */
export interface RunOcrPayload {
  force?: boolean;
  resetResults?: boolean;
  concurrency?: number;
  retryFailed?: boolean;
}

export interface OcrFailureReason {
  reason: string;
  count: number;
}

/** 主进程 OCR 进度事件。`sendOperationProgress` 原样转发，不得丢掉 failureReasons。 */
export interface OcrOperationProgress {
  operation: 'ocr';
  phase: string;
  percent?: number;
  total?: number;
  processed?: number;
  parsed?: number;
  skipped?: number;
  failed?: number;
  status?: string;
  code?: string;
  message?: string;
  kind?: string;
  done?: boolean;
  detail?: string;
  failureReasons?: OcrFailureReason[];
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function asDateRange(value: unknown): DateRangePayload {
  const raw = asObject(value);
  return {
    from: typeof raw.from === 'string' ? raw.from : undefined,
    to: typeof raw.to === 'string' ? raw.to : undefined,
    dryRun: raw.dryRun === true,
    matchSubject: typeof raw.matchSubject === 'boolean' ? raw.matchSubject : undefined,
    matchBody: typeof raw.matchBody === 'boolean' ? raw.matchBody : undefined,
  };
}

export function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function numberField(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return NaN;
}

export function ocrNeedsRerunBackup(raw: Record<string, unknown>): boolean {
  return raw.resetResults === true || raw.force === true || raw.retryFailed === true;
}

export function ocrHistoryTitle(raw: Record<string, unknown>): string {
  if (raw.retryFailed === true) return '重试失败项';
  if (raw.force === true) return '开始识别文件';
  return '识别文件';
}

export function appendOcrCliFlags(args: string[], raw: Record<string, unknown>): void {
  if (raw.force === true) args.push('--force');
  if (raw.retryFailed === true) args.push('--retry-failed');
}

const OCR_NO_WORK_MESSAGE = '没有等待识别的文件，请先在「开始处理」中获取邮件和发票文件。';

export function ocrNoWorkProgress(): Record<string, unknown> {
  return {
    operation: 'ocr',
    phase: '没有文件',
    percent: 100,
    total: 0,
    processed: 0,
    parsed: 0,
    skipped: 0,
    failed: 0,
    code: 'ocr_no_work',
    message: OCR_NO_WORK_MESSAGE,
    kind: 'warn',
    done: true,
  };
}

export function ocrNoWorkResponse(summary: unknown): Record<string, unknown> {
  return {
    ok: false,
    code: 'ocr_no_work',
    exitCode: 0,
    message: OCR_NO_WORK_MESSAGE,
    summary,
  };
}

/** force / resetResults 与 retryFailed 互斥。 */
export function invalidOcrPayloadResponse(
  raw: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const retryFailed = raw.retryFailed === true;
  const rerunAll = raw.force === true || raw.resetResults === true;
  if (!retryFailed || !rerunAll) return undefined;
  return {
    ok: false,
    code: 'invalid_ocr_payload',
    message: '「仅重试失败项」不能和「全部重新识别」一起使用。',
    ...extra,
  };
}
