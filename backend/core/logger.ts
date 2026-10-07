/**
 * Logger structuré : une ligne JSON par événement, sur stdout/stderr
 * (collectée par les journaux Vercel).
 *
 * Tout passe par `redact()` : aucun secret, cookie, jeton complet ni
 * mot de passe ne doit atteindre la sortie.
 */

import { redact, redactString } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Readonly<Record<string, unknown>>;

export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Logger enfant : les champs donnés sont ajoutés à chaque ligne. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly base?: LogFields;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

const defaultSink: LogSink = (level, line) => {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

/** Champs réservés : un appelant ne peut pas les écraser. */
const RESERVED = new Set(['level', 'time', 'msg']);

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const minimum = LEVEL_WEIGHT[options.level];
  const base = options.base ?? {};

  const write = (level: LogLevel, msg: string, fields: LogFields | undefined): void => {
    if (LEVEL_WEIGHT[level] < minimum) return;

    const merged: Record<string, unknown> = {};
    for (const source of [base, fields ?? {}]) {
      for (const [key, value] of Object.entries(source)) {
        if (!RESERVED.has(key)) merged[key] = value;
      }
    }

    const safeFields = redact(merged) as Record<string, unknown>;
    const entry = { level, time: now().toISOString(), msg: redactString(msg), ...safeFields };

    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ level, time: entry.time, msg: entry.msg, logError: 'unserializable_fields' });
    }
    sink(level, line);
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
