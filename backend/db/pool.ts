/**
 * Pool pg — portée module, une seule instance par processus.
 *
 * Transaction Pooler Supabase, rôle taply_app. `max: 1` : conservateur pour
 * démarrer (le pooler multiplexe déjà les connexions physiques ; à revoir
 * en Phase 3 si la concurrence par instance Fluid Compute le justifie).
 *
 * TLS — UNE seule source de vérité, explicite : l'objet `ssl` ci-dessous.
 * `sslmode`/`sslcert`/`sslkey`/`sslrootcert` sont interdits dans
 * DATABASE_URL_APP dès que l'environnement est staging/production (vérifié
 * par backend/core/config.ts) — jamais deux endroits qui pourraient
 * diverger. `rejectUnauthorized: true` (jamais `false`, nulle part) +
 * `ca` (le certificat CA PEM de Supabase, DATABASE_CA_CERT) donnent à Node
 * de quoi vérifier le certificat serveur **et** le hostname, sans se
 * reposer uniquement sur le magasin de confiance système.
 *
 * Aucune requête nommée nulle part dans backend/db/** (`.query(text,
 * values)` sans champ `name`) : chaque appel reste compatible avec le mode
 * transaction du pooler. Voir tests/unit/db/no-named-queries.test.ts.
 */

import { Pool } from 'pg';
import { getConfig } from '../core/config.js';
import { DbConfigError } from './errors.js';

let pool: Pool | undefined;

/** Lève DbConfigError si DATABASE_URL_APP est absent : jamais de connexion implicite. */
export function getPool(): Pool {
  if (pool !== undefined) return pool;

  const { db } = getConfig();
  if (db.appUrl === undefined) {
    throw new DbConfigError('DATABASE_URL_APP manquant : impossible de créer le pool de connexions.');
  }

  pool = new Pool({
    connectionString: db.appUrl,
    max: 1,
    ssl: {
      ca: db.caCert,
      rejectUnauthorized: true,
    },
  });
  return pool;
}

/** Tests uniquement : réinitialise le singleton entre deux scénarios. */
export function resetPoolForTests(): void {
  pool = undefined;
}
