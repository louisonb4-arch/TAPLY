/**
 * TenantContext : seule porte d'entrée pour toute transaction tenant-scoped.
 *
 * withTx    : BEGIN → callback → COMMIT ; ROLLBACK sur erreur ; release()
 *             dans un finally — toujours, une seule fois.
 * withTenantTx : withTx + set_config('app.merchant_id', …, true). Le `true`
 *             (local à la transaction) est ce qui garantit — par PostgreSQL
 *             lui-même, pas par discipline applicative — que le contexte ne
 *             survit jamais au COMMIT/ROLLBACK, même si le pool réutilise
 *             la même connexion physique pour la requête suivante.
 *
 * Exception documentée : `backend/db/lookup.ts` est le seul module qui
 * ouvre une transaction (via withTx) sans contexte tenant — c'est
 * délibéré, voir son commentaire.
 */

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { TenantContextError } from './errors.js';

const merchantIdSchema = z.uuid();

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {
      // La connexion peut déjà être cassée : on ne masque jamais l'erreur
      // d'origine avec un échec de rollback.
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function withTenantTx<T>(
  pool: Pool,
  merchantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const parsed = merchantIdSchema.safeParse(merchantId);
  if (!parsed.success) {
    throw new TenantContextError('merchantId invalide : un UUID est requis, aucune transaction ouverte.');
  }
  const validMerchantId = parsed.data;

  return withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.merchant_id', validMerchantId]);
    return fn(client);
  });
}
