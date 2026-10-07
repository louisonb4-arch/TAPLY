/**
 * Défense Origin/CSRF — via de vraies requêtes Hono (pas de contexte
 * simulé à la main). Vérifie fail-closed : absence/malformation/mismatch
 * d'Origin, et configuration APP_ORIGIN absente, rejettent toujours les
 * méthodes mutantes ; GET/HEAD ne sont jamais concernés.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../backend/core/config.js';
import { ERROR_CATALOG, isAppError, toErrorBody } from '../../../backend/core/errors.js';
import { originCheck } from '../../../backend/http/origin.js';
import type { AppEnvBindings } from '../../../backend/http/types.js';
import { captureLogger } from '../../helpers/capture-logger.js';

function buildApp(expectedOrigin: string | undefined) {
  const app = new Hono<AppEnvBindings>();
  const { logger } = captureLogger();
  app.use('*', async (c, next) => {
    c.set('config', { auth: { appOrigin: expectedOrigin } } as unknown as AppConfig);
    c.set('log', logger);
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.post('/mutate', originCheck, (c) => c.json({ ok: true }));
  app.get('/read', originCheck, (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (isAppError(err)) return c.json(toErrorBody(err, c.get('requestId')), err.status);
    throw err;
  });
  return app;
}

const EXPECTED = 'https://app.taply.example';

describe('originCheck — méthodes mutantes', () => {
  it('Origin exacte → passe', async () => {
    const app = buildApp(EXPECTED);
    const res = await app.request('/mutate', { method: 'POST', headers: { origin: EXPECTED } });
    expect(res.status).toBe(200);
  });

  it('Origin absente → rejetée', async () => {
    const app = buildApp(EXPECTED);
    const res = await app.request('/mutate', { method: 'POST' });
    expect(res.status).toBe(ERROR_CATALOG.ORIGIN_REJECTED.status);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ORIGIN_REJECTED');
  });

  it.each([
    'http://app.taply.example', // schéma différent
    'https://evil.example', // hôte différent
    'https://app.taply.example:8443', // port différent
    'not-an-origin',
  ])('Origin hostile %s → rejetée', async (hostile) => {
    const app = buildApp(EXPECTED);
    const res = await app.request('/mutate', { method: 'POST', headers: { origin: hostile } });
    expect(res.status).toBe(ERROR_CATALOG.ORIGIN_REJECTED.status);
  });

  it('APP_ORIGIN non configurée → rejette TOUTE mutation, même avec une Origin présente', async () => {
    const app = buildApp(undefined);
    const res = await app.request('/mutate', { method: 'POST', headers: { origin: EXPECTED } });
    expect(res.status).toBe(ERROR_CATALOG.ORIGIN_REJECTED.status);
  });
});

describe('originCheck — méthodes non mutantes', () => {
  it('GET : jamais filtré, même sans Origin ni config', async () => {
    const app = buildApp(undefined);
    const res = await app.request('/read');
    expect(res.status).toBe(200);
  });
});
