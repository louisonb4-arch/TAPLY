import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../backend/core/config.js';
import { AppError, ERROR_CATALOG } from '../../backend/core/errors.js';
import { createApp } from '../../backend/http/app.js';
import { captureLogger } from '../helpers/capture-logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup(env: Record<string, string> = {}) {
  const captured = captureLogger();
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test', ...env }), logger: captured.logger });
  return { app, ...captured };
}

describe('GET /api/health', () => {
  it('répond 200 avec un corps JSON minimal', async () => {
    const { app } = setup();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['requestId', 'service', 'status', 'time']);
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('taply-api');
    expect(Number.isNaN(Date.parse(String(body['time'])))).toBe(false);
  });

  it('renvoie un requestId UUID, identique en en-tête et dans le corps', async () => {
    const { app } = setup();
    const res = await app.request('/api/health');
    const header = res.headers.get('x-request-id');
    const body = (await res.json()) as { requestId: string };
    expect(header).toMatch(UUID_RE);
    expect(body.requestId).toBe(header);
  });

  it('génère un requestId différent à chaque requête et ignore celui du client', async () => {
    const { app } = setup();
    const a = await app.request('/api/health', { headers: { 'X-Request-Id': 'injected-by-client' } });
    const b = await app.request('/api/health');
    const idA = a.headers.get('x-request-id');
    expect(idA).toMatch(UUID_RE);
    expect(idA).not.toContain('injected');
    expect(idA).not.toBe(b.headers.get('x-request-id'));
  });

  it('pose les en-têtes de sécurité et Cache-Control: no-store', async () => {
    const { app } = setup();
    const res = await app.request('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
  });

  it('journalise la requête (sans query string) avec le requestId', async () => {
    const { app, entries } = setup();
    const res = await app.request('/api/health?token=SHOULD_NOT_APPEAR');
    const requestLog = entries().find((e) => e['msg'] === 'http.request');
    expect(requestLog).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/api/health',
      status: 200,
      requestId: res.headers.get('x-request-id'),
    });
    expect(typeof requestLog?.['durationMs']).toBe('number');
    expect(JSON.stringify(entries())).not.toContain('SHOULD_NOT_APPEAR');
  });
});

describe('périmètre et erreurs', () => {
  it('route inconnue sous /api → 404 JSON NOT_FOUND avec requestId', async () => {
    const { app } = setup();
    const res = await app.request('/api/inexistant');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe(ERROR_CATALOG.NOT_FOUND.message);
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it("Hono ne sert rien hors de /api (le site statique n'est pas son affaire)", async () => {
    const { app } = setup();
    for (const path of ['/', '/index.html', '/health', '/dashboard/', '/css/styles.css']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('méthode non prévue sur /api/health → pas de 200', async () => {
    const { app } = setup();
    const res = await app.request('/api/health', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('erreur inattendue → 500 générique, aucun détail interne dans la réponse, détail journalisé masqué', async () => {
    const { app, entries } = setup();
    app.get('/__test/boom', () => {
      throw new Error('connexion postgres://u:pw@db perdue');
    });
    const res = await app.request('/api/__test/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: ERROR_CATALOG.INTERNAL_ERROR.message,
        requestId: res.headers.get('x-request-id'),
      },
    });
    expect(text).not.toContain('postgres');
    expect(text).not.toContain('stack');

    const errorLog = entries().find((e) => e['msg'] === 'http.error');
    expect(errorLog).toMatchObject({ level: 'error', code: 'INTERNAL_ERROR', status: 500 });
    expect(JSON.stringify(errorLog)).not.toContain(':pw@');
  });

  it('AppError → son statut et son message utilisateur ; contexte de log non exposé', async () => {
    const { app, entries } = setup();
    app.get('/__test/invalid', () => {
      throw new AppError('VALIDATION_FAILED', { userMessage: 'Champ invalide.', logContext: { field: 'x' } });
    });
    const res = await app.request('/api/__test/invalid');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Champ invalide.' });
    expect(JSON.stringify(body)).not.toContain('field');
    expect(entries().find((e) => e['msg'] === 'http.error')).toMatchObject({ level: 'warn', field: 'x' });
  });

  it('corps trop volumineux → 413 PAYLOAD_TOO_LARGE', async () => {
    const { app } = setup({ API_BODY_LIMIT_BYTES: '1024' });
    app.post('/__test/echo', async (c) => c.json({ size: (await c.req.text()).length }));
    const small = await app.request('/api/__test/echo', { method: 'POST', body: 'x'.repeat(100) });
    expect(small.status).toBe(200);
    const big = await app.request('/api/__test/echo', {
      method: 'POST',
      body: 'x'.repeat(5_000),
      headers: { 'Content-Length': '5000' },
    });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
