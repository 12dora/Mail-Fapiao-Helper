type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

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
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  if (msg.length > max) out += '…';
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
