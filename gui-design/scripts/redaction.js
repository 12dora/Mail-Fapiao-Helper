import { text } from './dom.js';

/* ---------- Redaction (COPY-01 / COPY-05) ----------
   Anything that can reach a toast, the log export, a history entry or the
   clipboard passes through here first. This mirrors the rule set of
   src/electron/sanitize.ts so that the renderer fallback path (err.message,
   legacy stderr/error) is redacted just as strictly as main-process events:
   URL query/fragment, credential-looking assignments, ANY absolute
   POSIX/Windows/UNC path, and long content hashes. */
export const SECRET_PARAM_RE = /(token|secret|key|sign|signature|auth|password|passwd|pass|credential|session|ticket|code)/i;
export const SECRET_ASSIGN_RE = /\b(token|secret|secretid|secretkey|apikey|api_key|key|sign|signature|auth|authorization|password|passwd|pass|credential)(\s*[=:]\s*)("?)([^\s"',;&)]+)\3/gi;
export const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s"'<>）)\]，。；]+/gi;
export const UNC_PATH_RE = /\\\\[A-Za-z0-9._$-]+(?:\\[^\s"'<>|,;]+)+/g;
export const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s"'<>|,;]+/g;
// Any absolute POSIX path with at least two segments. The lookbehind keeps
// date-like `2026/05/21` and relative `a/b/c` out.
export const POSIX_PATH_RE = /(?<![A-Za-z0-9])(?:\/[A-Za-z0-9._@+\u4e00-\u9fa5-]+){2,}\/?/g;
export const HASH_RE = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi;
// Private-use sentinel for already-redacted fragments. Never a NUL byte:
// a literal 0x00 makes the source file look binary to git and tooling.
export const KEEP_MARK = '\uE000';

export function redactUrlText(raw) {
    try {
        const url = new URL(raw);
        const hasSecret = Array.from(url.searchParams.keys()).some((key) => SECRET_PARAM_RE.test(key));
        const base = `${url.protocol}//${url.host}${url.pathname}`;
        if (url.search || url.hash) return `${base}${hasSecret ? '?<凭据参数已隐藏>' : '?…'}`;
        return base;
    } catch {
        return raw.replace(/[?#].*$/, '');
    }
}

export function redactPathText(raw) {
    const parts = String(raw).trim().split(/[\\/]/).filter(Boolean);
    const base = parts.length > 0 ? parts[parts.length - 1] : '';
    return raw.includes('\\') ? `…\\${base}` : `…/${base}`;
}

export function sanitizeText(value, opts = {}) {
    if (value === undefined || value === null) return '';
    let out = typeof value === 'string' ? value : String(value);
    // Park each redacted fragment so later rules cannot re-slice a URL path
    // or an already-shortened filename.
    const kept = [];
    const keep = (replacement) => {
        kept.push(replacement);
        return `${KEEP_MARK}${kept.length - 1}${KEEP_MARK}`;
    };
    out = out.replace(URL_RE, (match) => keep(redactUrlText(match)));
    out = out.replace(UNC_PATH_RE, (match) => keep(redactPathText(match)));
    out = out.replace(WIN_PATH_RE, (match) => keep(redactPathText(match)));
    out = out.replace(POSIX_PATH_RE, (match) => keep(redactPathText(match)));
    out = out.replace(SECRET_ASSIGN_RE, (_m, key, sep) => `${key}${sep}***`);
    out = out.replace(HASH_RE, (match) => `${match.slice(0, 6)}…`);
    out = out.replace(new RegExp(`${KEEP_MARK}(\\d+)${KEEP_MARK}`, 'g'), (_m, index) => kept[Number(index)] ?? '');
    const max = Number(opts.maxLength) || 1200;
    if (out.length > max) out = `${out.slice(0, max)}…`;
    return out;
}

/* Short, shareable reference for a pending row instead of a raw hash. */
export function supportRef(hash) {
    const value = String(hash || '').trim();
    return value ? value.slice(0, 6).toUpperCase() : '——';
}

/* Prefer the backend's concise Chinese `message`; fall back to a redacted
   version of whatever legacy field is available. */
export function eventMessage(data) {
    const message = typeof data?.message === 'string' ? data.message : '';
    return sanitizeText(message);
}

export function eventDetail(data) {
    const detail = data?.detail ?? data?.stderr ?? data?.error ?? '';
    const text = typeof detail === 'string' ? detail : '';
    if (!text) return '';
    return sanitizeText(text).slice(0, 1200);
}

