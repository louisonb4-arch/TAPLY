/**
 * withTx / withTenantTx : ordre des appels (BEGIN/COMMIT/ROLLBACK/release),
 * sans base de données réelle — faux client, juste pour vérifier la
 * séquence. Les propriétés réelles (contexte qui ne fuit pas sur une
 * connexion de pool réutilisée) ne se prouvent que contre taply-staging
 * (tests/integration/db/*.staging.test.ts).
 *
 * Client potentiellement cassé (section « broken connection release ») :
 * release() doit recevoir un signal de discard (truthy) uniquement quand
 * le ROLLBACK lui-même échoue — jamais sur un simple échec de callback
 * avec rollback réussi. `getDbLogger` est mocké (silencieux, hermétique).
 */

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../backend/db/pool.js', () => ({
  getDbLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
}));

const { TenantContextError } = await import('../../../backend/db/errors.js');
const { withTenantTx, withTx } = await import('../../../backend/db/tenant-context.js');

function fakeClient(calls: string[], options: { failOn?: string[] } = {}) {
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push(values === undefined ? text : `${text} ${JSON.stringify(values)}`);
      if (options.failOn?.includes(text)) {
        throw new Error(`échec simulé sur ${text}`);
      }
      return { rows: [] };
    },
    release: (discard?: unknown) => {
      calls.push(discard === undefined ? 'release' : 'release(discard)');
    },
  };
  return client as unknown as PoolClient;
}

function fakePool(client: PoolClient) {
  return { connect: async () => client } as unknown as Pool;
}

describe('withTx', () => {
  it('begin → callback → commit → release normal, dans cet ordre', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const pool = fakePool(client);

    const result = await withTx(pool, async (c) => {
      await c.query('select 1');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toEqual(['begin', 'select 1', 'commit', 'release']);
  });

  it('A. callback échoue, ROLLBACK réussit → erreur d’origine propagée, release normal (pas de discard)', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const pool = fakePool(client);

    await expect(
      withTx(pool, async () => {
        throw new Error('boum métier');
      }),
    ).rejects.toThrow('boum métier');

    expect(calls).toEqual(['begin', 'rollback', 'release']);
  });

  it('B. callback échoue, ROLLBACK échoue aussi → erreur d’origine propagée (pas celle du rollback), client discard', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failOn: ['rollback'] });
    const pool = fakePool(client);

    await expect(
      withTx(pool, async () => {
        throw new Error('boum métier');
      }),
    ).rejects.toThrow('boum métier');

    expect(calls).toEqual(['begin', 'rollback', 'release(discard)']);
  });

  it('C. COMMIT échoue → rollback tenté ensuite, erreur de COMMIT propagée (pas masquée)', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failOn: ['commit'] });
    const pool = fakePool(client);

    await expect(
      withTx(pool, async (c) => {
        await c.query('select 1');
      }),
    ).rejects.toThrow('échec simulé sur commit');

    expect(calls).toEqual(['begin', 'select 1', 'commit', 'rollback', 'release']);
  });

  it('C bis. COMMIT échoue ET le ROLLBACK de secours échoue aussi → client discard, erreur de COMMIT propagée', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failOn: ['commit', 'rollback'] });
    const pool = fakePool(client);

    await expect(
      withTx(pool, async (c) => {
        await c.query('select 1');
      }),
    ).rejects.toThrow('échec simulé sur commit');

    expect(calls).toEqual(['begin', 'select 1', 'commit', 'rollback', 'release(discard)']);
  });

  it('D. BEGIN échoue → rollback de sécurité tenté, release reste cohérent avec son résultat', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failOn: ['begin'] });
    const pool = fakePool(client);

    await expect(withTx(pool, async () => 'jamais atteint')).rejects.toThrow('échec simulé sur begin');

    // rollback sans transaction en cours : no-op valide côté Postgres réel,
    // notre faux client le laisse réussir → release normal.
    expect(calls).toEqual(['begin', 'rollback', 'release']);
  });

  it('D bis. BEGIN échoue ET rollback échoue aussi (connexion vraiment cassée) → client discard', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failOn: ['begin', 'rollback'] });
    const pool = fakePool(client);

    await expect(withTx(pool, async () => 'jamais atteint')).rejects.toThrow('échec simulé sur begin');

    expect(calls).toEqual(['begin', 'rollback', 'release(discard)']);
  });
});

describe('withTenantTx', () => {
  it('pose set_config(app.merchant_id, …, true) juste après begin', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const pool = fakePool(client);
    const merchantId = '11111111-1111-4111-8111-111111111111';

    await withTenantTx(pool, merchantId, async (c) => {
      await c.query('select 1');
    });

    expect(calls[0]).toBe('begin');
    expect(calls[1]).toBe(`select set_config($1, $2, true) ["app.merchant_id","${merchantId}"]`);
    expect(calls[2]).toBe('select 1');
    expect(calls[3]).toBe('commit');
    expect(calls[4]).toBe('release');
  });

  it('refuse un merchantId non-UUID avant d’ouvrir la moindre connexion', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    let connected = false;
    const pool = { connect: async () => { connected = true; return client; } } as unknown as Pool;

    await expect(withTenantTx(pool, 'pas-un-uuid', async () => 'x')).rejects.toThrow(TenantContextError);
    expect(connected).toBe(false);
    expect(calls).toEqual([]);
  });
});
