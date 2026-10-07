/**
 * Harness de fiabilité runtime — STAGING UNIQUEMENT.
 *
 * Aucun secret dans ce fichier : il lit la configuration réelle
 * (DATABASE_URL_APP / DATABASE_CA_CERT / DATABASE_CONNECTION_TIMEOUT_MS)
 * via backend/core/config.ts + backend/db/pool.ts — le code applicatif
 * réel, pas une réimplémentation. Rien n'est codé en dur ici.
 *
 * Usage (staging, jamais production) :
 *   DATABASE_URL_APP=... DATABASE_CA_CERT=... \
 *     node --import ./scripts/dev-ts-hooks.mjs scripts/certification/db-runtime-reliability.ts
 *
 * Ne touche ni aux migrations, ni aux rôles, ni aux policies, ni aux
 * données — uniquement `SELECT 1` et une connexion délibérément ratée
 * vers une adresse réservée aux tests (RFC 5737, TEST-NET-1) pour prouver
 * que `connectionTimeoutMillis` borne réellement l'attente, sans jamais
 * toucher l'infrastructure Supabase elle-même.
 *
 * Ce que ce harness NE prouve PAS : une connexion saine qui meurt EN
 * COURS d'utilisation (socket qui se rompt mi-transaction). Il n'existe
 * aucun moyen sûr d'induire ça contre un vrai Supavisor sans toucher à
 * l'infra Supabase (redémarrage, coupure réseau) — explicitement interdit.
 * Ce scénario reste UNKNOWN, jamais simulé comme un faux PASS.
 */

import { Pool } from 'pg';
import { getConfig } from '../../backend/core/config.js';
import { getPool } from '../../backend/db/pool.js';
import { withTx } from '../../backend/db/tenant-context.js';

interface Results {
  firstQueryOk: boolean;
  secondQueryOk: boolean;
  noResidualContext: boolean;
  boundedTimeoutRespected: boolean;
  boundedTimeoutElapsedMs: number;
  poolUsableAfterUnrelatedFailure: boolean;
  staleSocketMidTransaction: 'UNKNOWN';
}

async function querySelectOne(): Promise<boolean> {
  return withTx(getPool(), async (client) => {
    const r = await client.query<{ one: number }>('select 1 as one');
    return r.rows[0]?.one === 1;
  });
}

async function main(): Promise<void> {
  // 1. connexion réelle + requête.
  const firstQueryOk = await querySelectOne();

  // 2. attente, puis requête à nouveau — prouve la réutilisation du pool.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const secondQueryOk = await querySelectOne();

  // 3. aucun contexte résiduel observable sur une requête nue.
  let noResidualContext: boolean;
  {
    const client = await getPool().connect();
    try {
      const g = await client.query<{ v: string | null }>("select current_setting('app.merchant_id', true) as v");
      const v = g.rows[0]?.v;
      noResidualContext = v === null || v === '';
    } finally {
      client.release();
    }
  }

  // 4. timeout borné : connexion délibérément ratée vers une adresse
  // réservée aux tests — jamais une infra Supabase.
  const { db } = getConfig();
  const boundTimeoutMs = Math.min(db.connectionTimeoutMs, 3_000);
  const badPool = new Pool({
    host: '192.0.2.1',
    port: 5432,
    user: 'nobody',
    password: 'unused',
    database: 'nonexistent',
    connectionTimeoutMillis: boundTimeoutMs,
    ssl: false,
  });
  let boundedTimeoutRespected: boolean;
  let boundedTimeoutElapsedMs: number;
  const startedAt = Date.now();
  try {
    await badPool.connect();
    boundedTimeoutRespected = false;
    boundedTimeoutElapsedMs = Date.now() - startedAt;
  } catch {
    boundedTimeoutElapsedMs = Date.now() - startedAt;
    // Marge de 1 s pour l'overhead du test lui-même, pas pour le timeout.
    boundedTimeoutRespected = boundedTimeoutElapsedMs <= boundTimeoutMs + 1_000;
  } finally {
    await badPool.end().catch(() => {
      /* pool jamais vraiment ouvert, rien à nettoyer */
    });
  }

  // 5. le pool applicatif réel reste utilisable après l'échec ci-dessus.
  const poolUsableAfterUnrelatedFailure = await querySelectOne();

  const results: Results = {
    firstQueryOk,
    secondQueryOk,
    noResidualContext,
    boundedTimeoutRespected,
    boundedTimeoutElapsedMs,
    poolUsableAfterUnrelatedFailure,
    staleSocketMidTransaction: 'UNKNOWN',
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(results, null, 2));
  await getPool().end();
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', error);
  process.exitCode = 1;
});
