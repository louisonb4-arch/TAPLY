/**
 * withTx / withTenantTx : ordre des appels (BEGIN/COMMIT/ROLLBACK/release),
 * sans base de données réelle — faux client, juste pour vérifier la
 * séquence. Les propriétés réelles (contexte qui ne fuit pas sur une
 * connexion de pool réutilisée) ne se prouvent que contre taply-staging
 * (tests/integration/db/*.staging.test.ts).
 */

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { TenantContextError } from '../../../backend/db/errors.js';
import { withTenantTx, withTx } from '../../../backend/db/tenant-context.js';

function fakeClient(calls: string[], options: { failOn?: string } = {}) {
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push(values === undefined ? text : `${text} ${JSON.stringify(values)}`);
      if (options.failOn !== undefined && text === options.failOn) {
        throw new Error(`échec simulé sur ${text}`);
      }
      return { rows: [] };
    },
    release: () => {
      calls.push('release');
    },
  };
  return client as unknown as PoolClient;
}

function fakePool(client: PoolClient) {
  return { connect: async () => client } as unknown as Pool;
}

describe('withTx', () => {
  it('begin → callback → commit → release, dans cet ordre', async () => {
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

  it('rollback puis release si le callback jette, erreur d’origine propagée', async () => {
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

  it('release appelé même si le rollback lui-même échoue', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failOn: 'rollback' });
    const pool = fakePool(client);

    await expect(
      withTx(pool, async () => {
        throw new Error('boum métier');
      }),
    ).rejects.toThrow('boum métier');

    expect(calls).toEqual(['begin', 'rollback', 'release']);
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
