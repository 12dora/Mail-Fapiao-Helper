export interface DateRangePayload {
  from?: string;
  to?: string;
  dryRun?: boolean;
  matchSubject?: boolean;
  matchBody?: boolean;
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
