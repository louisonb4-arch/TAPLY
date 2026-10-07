import { describe, expect, it } from 'vitest';
import { createLogger, type LogLevel } from '../../backend/core/logger.js';
import { captureLogger } from '../helpers/capture-logger.js';

describe('logger', () => {
  it('écrit une ligne JSON avec level, time, msg et champs', () => {
    const { logger, entries } = captureLogger();
    logger.info('http.request', { method: 'GET', status: 200 });
    expect(entries()).toEqual([
      {
        level: 'info',
        time: '2026-10-07T12:00:00.000Z',
        msg: 'http.request',
        service: 'taply-api-test',
        method: 'GET',
        status: 200,
      },
    ]);
  });

  it('filtre sous le niveau minimum', () => {
    const { logger, entries } = captureLogger('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(entries().map((e) => e['level'])).toEqual(['warn', 'error']);
  });

  it('le logger enfant ajoute ses champs', () => {
    const { logger, entries } = captureLogger();
    logger.child({ requestId: 'r-1' }).info('x', { a: 1 });
    expect(entries()[0]).toMatchObject({ requestId: 'r-1', a: 1, service: 'taply-api-test' });
  });

  it('ne laisse pas écraser level / time / msg', () => {
    const { logger, entries } = captureLogger();
    logger.info('vrai', { level: 'error', time: 'faux', msg: 'faux' });
    expect(entries()[0]).toMatchObject({ level: 'info', time: '2026-10-07T12:00:00.000Z', msg: 'vrai' });
  });

  it('masque les secrets dans les champs ET dans le message', () => {
    const { logger, lines } = captureLogger();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVl';
    logger.error(`échec auth Bearer abcdefghijklmnop`, {
      password: 'hunter2',
      access_token: jwt,
      refresh_token: 'rt-123456',
      cookie: '__Host-taply_sid=SESSIONSECRET',
      note: `jwt=${jwt}`,
      dsnUrl: 'postgres://u:pw@host:5432/db',
    });
    const output = lines.join('\n');
    for (const secret of ['hunter2', jwt, 'rt-123456', 'SESSIONSECRET', 'abcdefghijklmnop', ':pw@']) {
      expect(output).not.toContain(secret);
    }
  });

  it('écrit les niveaux warn/error sur stderr et les autres sur stdout par défaut', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const logger = createLogger({
      level: 'debug',
      sink: (level, line) => (level === 'warn' || level === 'error' ? stderr : stdout).push(line),
    });
    for (const level of levels) logger[level](level);
    expect(stdout).toHaveLength(2);
    expect(stderr).toHaveLength(2);
  });

  it('survit à des champs non sérialisables', () => {
    const { logger, entries } = captureLogger();
    logger.info('ok', { fn: () => 1, sym: Symbol('s') });
    expect(entries()[0]).toMatchObject({ msg: 'ok', fn: '[function]', sym: '[symbol]' });
  });
});
