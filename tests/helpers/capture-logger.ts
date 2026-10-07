import { createLogger, type LogLevel, type Logger } from '../../backend/core/logger.js';

export interface CapturedLogger {
  readonly logger: Logger;
  readonly lines: string[];
  readonly entries: () => Record<string, unknown>[];
}

/** Logger qui écrit dans un tableau (pour inspecter la sortie réelle). */
export function captureLogger(level: LogLevel = 'debug'): CapturedLogger {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    base: { service: 'taply-api-test' },
    sink: (_level, line) => {
      lines.push(line);
    },
    now: () => new Date('2026-10-07T12:00:00.000Z'),
  });
  return {
    logger,
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
