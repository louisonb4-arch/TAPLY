/**
 * Serveur de développement local (scripts/dev-server.ts) : il doit exposer
 * la vraie application via api/index.ts et reproduire le routage de vercel.json.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildStatic } from '../../scripts/build-static.mjs';
import { createDevApp } from '../../scripts/dev-server.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('dev-server : API seule', () => {
  const app = createDevApp();

  it('GET /api/health → vraie réponse de l’application Hono', async () => {
    const res = await app.request('http://127.0.0.1/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'taply-api' });
  });

  it('route API inconnue → 404 JSON de l’API', async () => {
    const res = await app.request('http://127.0.0.1/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('ne sert aucun fichier statique', async () => {
    expect((await app.request('http://127.0.0.1/index.html')).status).toBe(404);
  });
});

describe('dev-server : site + API (même routage que vercel.json)', () => {
  const siteDir = mkdtempSync(join(tmpdir(), 'taply-dev-site-'));
  buildStatic({ root: ROOT, out: siteDir, log: () => {} });
  const app = createDevApp({ siteDir });

  afterAll(() => {
    rmSync(siteDir, { recursive: true, force: true });
  });

  it('sert les pages du site', async () => {
    for (const path of ['/', '/connexion.html', '/dashboard/', '/robots.txt']) {
      expect((await app.request(`http://127.0.0.1${path}`)).status, path).toBe(200);
    }
  });

  it('/api/health → application Hono', async () => {
    const res = await app.request('http://127.0.0.1/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('URL inconnue et fichiers privés → vrai 404 avec 404.html', async () => {
    for (const path of ['/nope', '/backend/core/config.ts', '/package.json', '/tsconfig.json', '/api/../vercel.json']) {
      const res = await app.request(`http://127.0.0.1${path}`);
      expect(res.status, path).toBe(404);
    }
    const res = await app.request('http://127.0.0.1/nope');
    expect(await res.text()).toContain('<html');
  });
});
