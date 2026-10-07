/**
 * getPool : une seule source de vérité TLS, explicite — `ssl: { ca,
 * rejectUnauthorized: true }` — jamais de repli silencieux sur
 * `rejectUnauthorized: false` ni sur un paramètre ssl* d'URL. Vérifié
 * directement sur `pool.options` (pg-pool stocke exactement ce qui est
 * passé au constructeur, voir node_modules/pg-pool/index.js).
 */

import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getConfigMock = vi.fn();
vi.mock('../../../backend/core/config.js', () => ({ getConfig: getConfigMock }));

const { DbConfigError } = await import('../../../backend/db/errors.js');
const { getPool, resetPoolForTests } = await import('../../../backend/db/pool.js');

const FAKE_CA_CERT = '-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----';

afterEach(() => {
  resetPoolForTests();
  getConfigMock.mockReset();
});

describe('getPool', () => {
  it('lève DbConfigError si DATABASE_URL_APP est absent', () => {
    getConfigMock.mockReturnValue({ db: { appUrl: undefined, caCert: undefined } });
    expect(() => getPool()).toThrow(DbConfigError);
  });

  it('configure ssl explicitement : ca = DATABASE_CA_CERT, rejectUnauthorized toujours true', () => {
    const url = 'postgresql://taply_app:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
    getConfigMock.mockReturnValue({ db: { appUrl: url, caCert: FAKE_CA_CERT } });

    const pool = getPool() as unknown as Pool & { options: Record<string, unknown> };

    expect(pool.options.connectionString).toBe(url);
    expect(pool.options.max).toBe(1);
    expect(pool.options.ssl).toEqual({ ca: FAKE_CA_CERT, rejectUnauthorized: true });
  });

  it('rejectUnauthorized reste true même si aucun certificat CA n’est fourni (dev sans DATABASE_CA_CERT)', () => {
    getConfigMock.mockReturnValue({ db: { appUrl: 'postgresql://x:y@host:6543/postgres', caCert: undefined } });

    const pool = getPool() as unknown as Pool & { options: Record<string, unknown> };

    expect(pool.options.ssl).toEqual({ ca: undefined, rejectUnauthorized: true });
  });

  it('réutilise la même instance (singleton de portée module)', () => {
    getConfigMock.mockReturnValue({ db: { appUrl: 'postgresql://x:y@host:6543/postgres', caCert: FAKE_CA_CERT } });
    expect(getPool()).toBe(getPool());
  });

  it('connectionTimeoutMillis vient de getConfig().db.connectionTimeoutMs (jamais 0/illimité par défaut)', () => {
    getConfigMock.mockReturnValue({
      db: { appUrl: 'postgresql://x:y@host:6543/postgres', caCert: FAKE_CA_CERT, connectionTimeoutMs: 1234 },
    });
    const pool = getPool() as unknown as Pool & { options: Record<string, unknown> };
    expect(pool.options.connectionTimeoutMillis).toBe(1234);
  });

  it("pool.on('error') : un évènement error ne devient jamais une exception non gérée", () => {
    getConfigMock.mockReturnValue({
      logLevel: 'error',
      db: { appUrl: 'postgresql://x:y@host:6543/postgres', caCert: FAKE_CA_CERT, connectionTimeoutMs: 5000 },
    });
    const pool = getPool();
    expect(() => {
      pool.emit('error', new Error('connexion idle rompue'), undefined as never);
    }).not.toThrow();
  });

  it("pool.on('error') : journalise db.pool.error sans exposer de secret (pipeline de redaction réel, pas mocké)", () => {
    getConfigMock.mockReturnValue({
      logLevel: 'error',
      db: { appUrl: 'postgresql://x:y@host:6543/postgres', caCert: FAKE_CA_CERT, connectionTimeoutMs: 5000 },
    });
    const pool = getPool();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      pool.emit(
        'error',
        new Error('connection reset: postgresql://taply_app:SuperSecretPass@host/db'),
        undefined as never,
      );
      expect(writeSpy).toHaveBeenCalled();
      const line = String(writeSpy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed['msg']).toBe('db.pool.error');
      expect(line).not.toContain('SuperSecretPass');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
