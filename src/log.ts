type Level = 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function emit(level: Level, msg: string): void {
  const stream = level === 'info' ? process.stdout : process.stderr;
  stream.write(`[${level}] ${new Date().toISOString()} ${msg}\n`);
}

export const log: Logger = {
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
};
