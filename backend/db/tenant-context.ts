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
 *
 * Client potentiellement cassé après erreur : si le ROLLBACK lui-même
 * échoue, la connexion est tenue pour défaillante — on ne la rend jamais
 * réutilisable (`client.release(err)` : pg l'évacue au lieu de la remettre
 * idle, voir node_modules/pg-pool/index.js `_release`). L'erreur
 * applicative d'origine reste celle propagée ; l'échec du rollback est
 * seulement journalisé (jamais masqué, jamais substitué à l'erreur
 * d'origine). Aucune détection d'état de connexion plus fine que ça :
 * l'échec du rollback est la seule preuve qu'on exploite, par choix.
 */

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { getDbLogger } from './pool.js';
import { TenantContextError } from './errors.js';

const merchantIdSchema = z.uuid();

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard: Error | undefined;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      getDbLogger().warn('db.transaction.rollback_failed', { error: rollbackError });
    }
    throw error;
  } finally {
    client.release(discard);
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
