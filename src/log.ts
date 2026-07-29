type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * 机器可读终态行前缀（可选增强通道，CORE-13 / BLOCKING 5）。
 *
 * 主契约（与 Electron `lastAnchoredTerminalLine` 对齐）：
 * - 物理行以 `Run complete:` 开头（行首锚定），例如：
 *   `Run complete: processed=0, partial=0, skipped=0, failed=0, archived=0, pending=0`
 * - 普通 `log.*` 输出经 `sanitizeLogMessage` 会把不可信文本中的 `Run complete:` 插入零宽字符，
 *   且始终带有 `[level] ISO ` 信封，因此附件名等同子串无法伪造「行首 / 去信封后行首」匹配。
 *
 * 增强通道（供未来/并行解析器）：
 * - 另发一行 `\x1eMFH_TERMINAL\x1e Run complete: …`，正则：`/^\x1eMFH_TERMINAL\x1e Run complete:/m`
 */
export const MFH_TERMINAL_MARKER = '\x1eMFH_TERMINAL\x1e';

/**
 * CORE-13：把不可信文本里的换行/回车/控制字符转成可见转义，保证一条逻辑日志
 * 仍是一行物理输出。Electron 的进度协议按行正则解析 stdout，未转义的 subject/
 * from 会截断诊断甚至伪造 `saved`/`processed` 标记。
 */
function sanitizeLogMessage(msg: string): string {
  // 限制单条长度，避免超大邮件字段把日志管道撑爆。
  const max = 4000;
  let out = '';
  const n = Math.min(msg.length, max);
  for (let i = 0; i < n; i++) {
    const code = msg.charCodeAt(i);
    const ch = msg[i]!;
    if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      // 含 RS(\x1e) 等控制字符：可见转义，避免伪造终态标记。
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  if (msg.length > max) out += '…';
  // 同子串注入：不可信文本不得复现「去信封后行首 = Run complete:」的终态形态。
  out = out.replace(/Run complete:/gi, 'Run complete\u200b:');
  out = out.replace(/MFH_TERMINAL/g, 'MFH_TERMINAL\u200b');
  return out;
}

function emit(level: Level, msg: string): void {
  const stream = level === 'info' || level === 'debug' ? process.stdout : process.stderr;
  stream.write(`[${level}] ${new Date().toISOString()} ${sanitizeLogMessage(msg)}\n`);
}

export const log: Logger = {
  debug: (m) => emit('debug', m),
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
};

/**
 * 发出不可伪造的机器终态行。
 *
 * `payload` 形如：
 * `Run complete: processed=…, partial=…, skipped=…, failed=…, archived=…, pending=…`
 *
 * 写出两行（字段值不得含不可信邮件字段，调用方只填数字计数）：
 * 1. `\x1eMFH_TERMINAL\x1e Run complete: …` — 增强锚定通道
 * 2. `Run complete: …` — 与 Electron `lastAnchoredTerminalLine(..., 'Run complete:')` 对齐的行首锚定
 */
export function emitTerminal(payload: string): void {
  // 终态不得含物理换行；控制字符压成空格，保留 "Run complete:" 字面量供解析。
  const flat = payload.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim();
  process.stdout.write(`${MFH_TERMINAL_MARKER} ${flat}\n`);
  process.stdout.write(`${flat}\n`);
}
