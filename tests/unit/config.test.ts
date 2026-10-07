import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../backend/core/config.js';
import { ConfigError } from '../../backend/core/errors.js';

describe('loadConfig', () => {
  it('fournit des valeurs par défaut sûres en développement', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      appEnv: 'development',
      logLevel: 'debug',
      api: { bodyLimitBytes: 65_536 },
      urls: { publicBase: undefined, merchantAppBase: undefined, joinBase: undefined, walletWebService: undefined },
    });
  });

  it.each([
    [{ VERCEL_ENV: 'production' }, 'production'],
    [{ VERCEL_ENV: 'preview' }, 'staging'],
    [{ VERCEL_ENV: 'development' }, 'development'],
    [{ NODE_ENV: 'test' }, 'test'],
    [{ APP_ENV: 'staging', VERCEL_ENV: 'production' }, 'staging'],
  ] as const)('déduit APP_ENV de %o → %s', (env, expected) => {
    expect(loadConfig(env).appEnv).toBe(expected);
  });

  it('niveau de log par défaut : info hors développement', () => {
    expect(loadConfig({ VERCEL_ENV: 'production' }).logLevel).toBe('info');
    expect(loadConfig({ VERCEL_ENV: 'production', LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
  });

  it('normalise les URL (sans slash final)', () => {
    const config = loadConfig({ PUBLIC_BASE_URL: 'https://taply.example/', JOIN_BASE_URL: 'https://go.taply.example' });
    expect(config.urls.publicBase).toBe('https://taply.example');
    expect(config.urls.joinBase).toBe('https://go.taply.example');
  });

  it('refuse une URL invalide', () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'pas une url' })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'ftp://taply.example' })).toThrow(ConfigError);
  });

  it('exige HTTPS en staging et production, tolère HTTP en développement', () => {
    expect(() => loadConfig({ APP_ENV: 'production', JOIN_BASE_URL: 'http://go.taply.example' })).toThrow(
      /JOIN_BASE_URL: HTTPS obligatoire/,
    );
    expect(() => loadConfig({ APP_ENV: 'staging', WALLET_WEB_SERVICE_URL: 'http://w.example' })).toThrow(ConfigError);
    expect(loadConfig({ APP_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:3000' }).urls.publicBase).toBe(
      'http://localhost:3000',
    );
  });

  it('borne la limite de corps', () => {
    expect(loadConfig({ API_BODY_LIMIT_BYTES: '2048' }).api.bodyLimitBytes).toBe(2_048);
    expect(() => loadConfig({ API_BODY_LIMIT_BYTES: '10' })).toThrow(ConfigError);
    expect(() => loadConfig({ API_BODY_LIMIT_BYTES: '99999999' })).toThrow(ConfigError);
  });

  it("n'inclut jamais la valeur fautive dans le message d'erreur", () => {
    const secretLike = 'https-but-wrong://user:SuperSecret@host';
    try {
      loadConfig({ APP_ENV: 'nope' as never, PUBLIC_BASE_URL: secretLike, LOG_LEVEL: 'loud' as never });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('APP_ENV');
      expect(message).toContain('LOG_LEVEL');
      expect(message).toContain('PUBLIC_BASE_URL');
      expect(message).not.toContain('SuperSecret');
      expect(message).not.toContain('nope');
      expect(message).not.toContain('loud');
    }
  });

  it('ignore les variables inconnues', () => {
    expect(() => loadConfig({ SOMETHING_ELSE: 'x', PATH: '/usr/bin' })).not.toThrow();
  });
});
