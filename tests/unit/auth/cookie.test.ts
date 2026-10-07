/**
 * Cookie de session : testé via une vraie requête/réponse Hono (pas un
 * Context simulé à la main) — c'est le seul moyen fiable de vérifier les
 * attributs exacts du Set-Cookie émis, y compris le comportement forcé
 * par le préfixe __Host- (secure/path/domain) côté Hono lui-même.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clearSessionCookie, getSessionCookie, setSessionCookie } from '../../../backend/auth/cookie.js';
import type { AppEnv } from '../../../backend/core/config.js';
import type { AppEnvBindings } from '../../../backend/http/types.js';

function buildApp(appEnv: AppEnv) {
  const app = new Hono<AppEnvBindings>();
  app.post('/set', (c) => {
    setSessionCookie(c, appEnv, 'raw-token-value', 3_600);
    return c.text('ok');
  });
  app.get('/get', (c) => c.json({ value: getSessionCookie(c, appEnv) ?? null }));
  app.post('/clear', (c) => {
    clearSessionCookie(c, appEnv);
    return c.text('ok');
  });
  return app;
}

describe('setSessionCookie — staging/production', () => {
  it.each(['staging', 'production'] as const)('%s : __Host- préfixé, Secure, HttpOnly, SameSite=Lax, Path=/, pas de Domain', async (appEnv) => {
    const app = buildApp(appEnv);
    const res = await app.request('/set', { method: 'POST' });
    const setCookie = res.headers.get('set-cookie') ?? '';

    expect(setCookie).toMatch(/^__Host-taply_session=raw-token-value/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).toContain('Max-Age=3600');
  });
});

describe('setSessionCookie — development', () => {
  it('nom de cookie simple, pas de Secure (localhost, pas de HTTPS)', async () => {
    const app = buildApp('development');
    const res = await app.request('/set', { method: 'POST' });
    const setCookie = res.headers.get('set-cookie') ?? '';

    expect(setCookie).toMatch(/^taply_session=raw-token-value/);
    expect(setCookie).not.toMatch(/__Host-/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toMatch(/Secure/i);
  });
});

describe('getSessionCookie', () => {
  it.each(['staging', 'production'] as const)('%s : lit __Host-taply_session', async (appEnv) => {
    const app = buildApp(appEnv);
    const res = await app.request('/get', { headers: { cookie: '__Host-taply_session=abc123' } });
    expect(await res.json()).toEqual({ value: 'abc123' });
  });

  it('development : lit taply_session (sans préfixe)', async () => {
    const app = buildApp('development');
    const res = await app.request('/get', { headers: { cookie: 'taply_session=abc123' } });
    expect(await res.json()).toEqual({ value: 'abc123' });
  });

  it('absent : undefined, jamais une exception', async () => {
    const app = buildApp('production');
    const res = await app.request('/get');
    expect(await res.json()).toEqual({ value: null });
  });
});

describe('clearSessionCookie', () => {
  it.each(['staging', 'production'] as const)('%s : Max-Age=0 sur __Host-taply_session', async (appEnv) => {
    const app = buildApp(appEnv);
    const res = await app.request('/clear', { method: 'POST' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-taply_session=;/);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('development : Max-Age=0 sur taply_session', async () => {
    const app = buildApp('development');
    const res = await app.request('/clear', { method: 'POST' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^taply_session=;/);
    expect(setCookie).toContain('Max-Age=0');
  });
});
