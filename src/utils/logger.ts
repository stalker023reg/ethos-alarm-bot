type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';

function shouldLog(level: LogLevel): boolean {
  return levelWeight[level] >= levelWeight[configuredLevel];
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) {
    return;
  }

  const timestamp = new Date().toISOString();
  const payload = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${payload}`;

  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
}

/**
 * Small structured logger to keep logging consistent across modules.
 */
export const logger = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};
