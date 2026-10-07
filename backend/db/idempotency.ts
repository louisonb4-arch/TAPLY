/**
 * runIdempotent : claim + callback métier + finalize, dans LA MÊME
 * transaction que l'appelant — ce module n'ouvre ni ne ferme jamais de
 * transaction lui-même. Le `client` reçu doit déjà être dans une
 * transaction ouverte (typiquement via withTenantTx).
 *
 * Concurrence (même clé + même empreinte) : l'INSERT du second appelant
 * bloque sur l'index unique jusqu'à ce que le premier commit ou rollback.
 * Comme claim + callback + finalize sont dans UNE transaction, quand le
 * second se débloque, la ligne est déjà dans son état final
 * ('completed' + réponse) — jamais observée à mi-chemin.
 *
 * Limite assumée (Amendment A1) : sans identité client persistante, deux
 * clés d'idempotence indépendantes ne peuvent pas être prouvées comme
 * appartenant à la même personne. Ce module ne déduplique que sur la
 * clé elle-même — jamais au-delà.
 */

import type { PoolClient } from 'pg';
import { IdempotencyConflictError } from './errors.js';

export interface IdempotencyParams {
  readonly merchantId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

interface ClaimRow {
  readonly id: string;
}

interface ExistingRow {
  readonly request_fingerprint: string;
  readonly response: unknown;
}

export async function runIdempotent<T>(client: PoolClient, params: IdempotencyParams, fn: () => Promise<T>): Promise<T> {
  const claim = await client.query<ClaimRow>(
    `insert into taply.idempotency_requests (merchant_id, operation, idempotency_key, request_fingerprint)
     values ($1, $2, $3, $4)
     on conflict (merchant_id, operation, idempotency_key) do nothing
     returning id`,
    [params.merchantId, params.operation, params.idempotencyKey, params.fingerprint],
  );

  const claimed = claim.rows[0];
  if (claimed !== undefined) {
    const result = await fn();
    await client.query(
      `update taply.idempotency_requests
       set status = 'completed', response = $2, updated_at = now()
       where id = $1`,
      [claimed.id, JSON.stringify(result)],
    );
    return result;
  }

  const existing = await client.query<ExistingRow>(
    `select request_fingerprint, response
     from taply.idempotency_requests
     where merchant_id = $1 and operation = $2 and idempotency_key = $3`,
    [params.merchantId, params.operation, params.idempotencyKey],
  );
  const row = existing.rows[0];
  if (row === undefined || row.request_fingerprint !== params.fingerprint) {
    throw new IdempotencyConflictError({
      merchantId: params.merchantId,
      operation: params.operation,
      idempotencyKey: params.idempotencyKey,
    });
  }
  return row.response as T;
}
