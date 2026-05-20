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

export function createLogger(level: Level): Logger {
  const levels: Level[] = ['debug', 'info', 'warn', 'error'];
  const threshold = levels.indexOf(level);
  return {
    debug: (m) => threshold <= 0 && emit('debug', m),
    info: (m) => threshold <= 1 && emit('info', m),
    warn: (m) => threshold <= 2 && emit('warn', m),
    error: (m) => threshold <= 3 && emit('error', m),
  };
}
