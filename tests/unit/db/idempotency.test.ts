/**
 * runIdempotent : logique claim/replay/conflict, avec un faux client qui
 * simule la table idempotency_requests en mémoire (une seule ligne, un
 * seul merchant/operation/key — suffisant pour tester la décision).
 * La concurrence réelle (deux transactions simultanées, vrai verrou
 * d'index unique) ne se prouve que contre taply-staging
 * (tests/integration/db/idempotency-concurrency.staging.test.ts).
 */

import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { IdempotencyConflictError } from '../../../backend/db/errors.js';
import { runIdempotent } from '../../../backend/db/idempotency.js';

interface StoredRow {
  id: string;
  merchant_id: string;
  operation: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: string;
  response: unknown;
}

/** Simule exactement les trois requêtes SQL émises par runIdempotent. */
function fakeClient(store: Map<string, StoredRow>) {
  let nextId = 1;
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.startsWith('insert into taply.idempotency_requests')) {
        const [merchantId, operation, idempotencyKey, fingerprint] = values as [string, string, string, string];
        const key = `${merchantId}:${operation}:${idempotencyKey}`;
        if (store.has(key)) return { rows: [] }; // ON CONFLICT DO NOTHING
        const row: StoredRow = {
          id: String(nextId++),
          merchant_id: merchantId,
          operation,
          idempotency_key: idempotencyKey,
          request_fingerprint: fingerprint,
          status: 'pending',
          response: null,
        };
        store.set(key, row);
        return { rows: [{ id: row.id }] };
      }
      if (text.startsWith('update taply.idempotency_requests')) {
        const [id, response] = values as [string, string];
        for (const row of store.values()) {
          if (row.id === id) {
            row.status = 'completed';
            row.response = JSON.parse(response);
          }
        }
        return { rows: [] };
      }
      if (text.startsWith('select request_fingerprint, response')) {
        const [merchantId, operation, idempotencyKey] = values as [string, string, string];
        const key = `${merchantId}:${operation}:${idempotencyKey}`;
        const row = store.get(key);
        return { rows: row === undefined ? [] : [{ request_fingerprint: row.request_fingerprint, response: row.response }] };
      }
      throw new Error(`requête inattendue dans le faux client : ${text}`);
    },
  };
  return client as unknown as PoolClient;
}

const baseParams = { merchantId: 'm1', operation: 'enroll_customer', idempotencyKey: 'key-1', fingerprint: 'fp-a' };

describe('runIdempotent', () => {
  it('exécute le callback une seule fois et stocke son résultat', async () => {
    const store = new Map<string, StoredRow>();
    const client = fakeClient(store);
    let calls = 0;

    const result = await runIdempotent(client, baseParams, async () => {
      calls += 1;
      return { ok: true };
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(store.get('m1:enroll_customer:key-1')?.status).toBe('completed');
  });

  it('même clé + même empreinte : replay, callback jamais ré-exécuté', async () => {
    const store = new Map<string, StoredRow>();
    const client = fakeClient(store);
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { ok: true, n: calls };
    };

    const first = await runIdempotent(client, baseParams, fn);
    const second = await runIdempotent(client, baseParams, fn);

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('même clé + empreinte différente : IdempotencyConflictError', async () => {
    const store = new Map<string, StoredRow>();
    const client = fakeClient(store);

    await runIdempotent(client, baseParams, async () => ({ ok: true }));

    await expect(runIdempotent(client, { ...baseParams, fingerprint: 'fp-b' }, async () => ({ ok: true }))).rejects.toThrow(
      IdempotencyConflictError,
    );
  });
});
