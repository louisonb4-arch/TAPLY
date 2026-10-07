import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Point d'entrée réel de la Vercel Function (api/index.ts) :
 * même module que celui exécuté en production.
 */

afterEach(() => {
  vi.resetModules();
});

describe('api/index.ts', () => {
  it('exporte un handler fetch qui sert /api/health', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const entry = (await import('../../api/index.js')).default;
    expect(typeof entry.fetch).toBe('function');
    const res = await entry.fetch(new Request('https://taply.test/api/health'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });

  it("route sur le chemin d'origine même après réécriture /api/* → /api", async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const entry = (await import('../../api/index.js')).default;
    const res = await entry.fetch(new Request('https://taply.test/api/does-not-exist'));
    expect(res.status).toBe(404);
  });

  it('configuration invalide → 503 générique sans fuite, erreur journalisée sans valeurs', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('JOIN_BASE_URL', 'http://insecure.example/?secret=LEAK');
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });

    const entry = (await import('../../api/index.js')).default;
    const res = await entry.fetch(new Request('https://taply.test/api/health'));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(text).not.toContain('LEAK');

    const logged = stderr.join('');
    expect(logged).toContain('startup.failed');
    expect(logged).toContain('JOIN_BASE_URL');
    expect(logged).not.toContain('LEAK');
    expect(logged).not.toContain('insecure.example');
  });
});
