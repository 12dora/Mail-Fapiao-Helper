import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface State {
  processedHashes: string[];
  fetchedHashes: string[];
}

export function loadState(path: string): State {
  if (!existsSync(path)) {
    return { processedHashes: [], fetchedHashes: [] };
  }
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`state at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`state at ${path} must be a JSON object`);
  }
  const r = raw as Record<string, unknown>;
  const processed = r.processedHashes;
  const fetched = r.fetchedHashes;
  return {
    processedHashes: Array.isArray(processed) ? processed.filter((x): x is string => typeof x === 'string') : [],
    fetchedHashes: Array.isArray(fetched) ? fetched.filter((x): x is string => typeof x === 'string') : [],
  };
}

export function saveState(path: string, state: State): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}
