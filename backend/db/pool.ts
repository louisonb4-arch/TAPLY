/**
 * Pool pg — portée module, une seule instance par processus.
 *
 * Transaction Pooler Supabase, rôle taply_app. `max: 1` : conservateur pour
 * démarrer (le pooler multiplexe déjà les connexions physiques). Prouvé
 * sûr (pas optimal) par la certification Phase 2B contre le vrai
 * Supavisor : 10 → 25 → 50 connexions concurrentes, zéro fuite
 * cross-tenant. Ne pas augmenter sans mesure réelle (pool wait observé +
 * charge applicative réelle) — rien ne justifie 2/4 aujourd'hui, aucune
 * route n'existe encore.
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
 * `connectionTimeoutMillis` — borne la file d'attente ET l'établissement
 * d'une connexion neuve (node-postgres utilise le même réglage pour les
 * deux). Voir backend/core/config.ts pour la justification de la valeur
 * par défaut (5 s) et ses bornes (100 ms – 60 s, jamais 0/illimité).
 *
 * `pool.on('error', ...)` — un client idle qui lève une erreur réseau
 * (ex. connexion coupée côté serveur) émet un évènement 'error' sur le
 * Pool lui-même (EventEmitter) ; sans listener, Node le traite comme une
 * exception non gérée et plante le processus. On le journalise (champs
 * sûrs uniquement, via l'infrastructure de redaction existante) et on
 * laisse pg évacuer le client défaillant — jamais d'arrêt manuel du
 * processus ici.
 *
 * Aucune requête nommée nulle part dans backend/db/** (`.query(text,
 * values)` sans champ `name`) : chaque appel reste compatible avec le mode
 * transaction du pooler. Voir tests/unit/db/no-named-queries.test.ts.
 */

import { Pool } from 'pg';
import { getConfig } from '../core/config.js';
import { createLogger, type Logger } from '../core/logger.js';
import { DbConfigError } from './errors.js';

let pool: Pool | undefined;
let dbLogger: Logger | undefined;

/** Logger dédié au module DB — portée module, comme le pool lui-même. */
export function getDbLogger(): Logger {
  dbLogger ??= createLogger({ level: getConfig().logLevel, base: { service: 'taply-db' } });
  return dbLogger;
}

/** Lève DbConfigError si DATABASE_URL_APP est absent : jamais de connexion implicite. */
export function getPool(): Pool {
  if (pool !== undefined) return pool;

  const { db } = getConfig();
  if (db.appUrl === undefined) {
    throw new DbConfigError('DATABASE_URL_APP manquant : impossible de créer le pool de connexions.');
  }

  const created = new Pool({
    connectionString: db.appUrl,
    max: 1,
    connectionTimeoutMillis: db.connectionTimeoutMs,
    ssl: {
      ca: db.caCert,
      rejectUnauthorized: true,
    },
  });

  created.on('error', (error, client) => {
    getDbLogger().error('db.pool.error', {
      error,
      hadClient: client !== undefined,
    });
  });

  pool = created;
  return pool;
}

/** Tests uniquement : réinitialise les singletons entre deux scénarios. */
export function resetPoolForTests(): void {
  pool = undefined;
  dbLogger = undefined;
}
