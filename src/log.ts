type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function emit(level: Level, msg: string): void {
  const stream = level === 'info' || level === 'debug' ? process.stdout : process.stderr;
  stream.write(`[${level}] ${new Date().toISOString()} ${msg}\n`);
}

export const log: Logger = {
  debug: (m) => emit('debug', m),
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
};
