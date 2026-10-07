/**
 * Transactions de session Auth — construites sur `withTx` (jamais sur
 * `withTenantTx`, et jamais en modifiant tenant-context.ts : l'Auth pose
 * une séquence de GUC à elle, distincte du TenantContext métier).
 *
 * Résolution d'une requête authentifiée (section « SESSION RESOLUTION
 * TRANSACTION ») :
 *   BEGIN
 *   → set_config('app.session_token_hash', …, true)
 *   → SELECT session active exacte (WHERE token_hash = $1 — filtre
 *     applicatif explicite, EN PLUS de la policy RLS qui l'exige
 *     indépendamment)
 *   → set_config('app.auth_user_id', …, true)
 *   → vérifie exactement le merchant_user (WHERE id = $1 AND
 *     auth_user_id = $2 — même principe : filtre + RLS indépendante)
 *   → set_config('app.merchant_id', …, true)
 *   → callback métier authentifié
 *   → COMMIT / ROLLBACK efface les trois GUC (transaction-locaux, voir
 *     tenant-context.ts pour la garantie PostgreSQL sous-jacente)
 *
 * Jamais de valeur envoyée par le navigateur utilisée directement comme
 * merchantId/authUserId/role : tout est dérivé côté serveur, dans cette
 * même transaction, à partir du seul jeton de session.
 */

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withTx } from '../db/tenant-context.js';
import { AuthInvalidCredentialsError, SessionInvalidError } from './errors.js';
import { generateSessionToken, hashSessionToken } from './token.js';

export type MerchantRole = 'owner' | 'staff';

export interface AuthenticatedPrincipal {
  readonly sessionId: string;
  readonly merchantId: string;
  readonly merchantUserId: string;
  readonly authUserId: string;
  readonly role: MerchantRole;
}

export interface MerchantUserMapping {
  readonly id: string;
  readonly merchantId: string;
  readonly role: MerchantRole;
}

const uuidSchema = z.uuid();
const roleSchema = z.enum(['owner', 'staff']);

interface SessionRow {
  readonly id: string;
  readonly merchant_user_id: string;
  readonly auth_user_id: string;
}

interface MerchantUserRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly role: string;
  readonly status: string;
}

/**
 * Résout une requête authentifiée à partir du jeton brut de session.
 * Touch V1 : met à jour last_seen_at/idle_expires_at à chaque appel
 * réussi, jamais au-delà de absolute_expires_at (LEAST côté SQL, pas
 * côté application).
 */
export async function withAuthenticatedTx<T>(
  pool: Pool,
  rawSessionToken: string,
  idleSeconds: number,
  fn: (client: PoolClient, principal: AuthenticatedPrincipal) => Promise<T>,
): Promise<T> {
  const tokenHash = hashSessionToken(rawSessionToken);

  return withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.session_token_hash', tokenHash]);

    const sessionResult = await client.query<SessionRow>(
      `select id, merchant_user_id, auth_user_id
       from taply.merchant_sessions
       where token_hash = $1
         and revoked_at is null
         and idle_expires_at > now()
         and absolute_expires_at > now()`,
      [tokenHash],
    );
    const session = sessionResult.rows[0];
    if (session === undefined) throw new SessionInvalidError();

    await client.query('select set_config($1, $2, true)', ['app.auth_user_id', session.auth_user_id]);

    const userResult = await client.query<MerchantUserRow>(
      `select id, merchant_id, role, status
       from taply.merchant_users
       where id = $1 and auth_user_id = $2`,
      [session.merchant_user_id, session.auth_user_id],
    );
    const merchantUser = userResult.rows[0];
    if (merchantUser === undefined || merchantUser.status !== 'active') throw new SessionInvalidError();

    const role = roleSchema.safeParse(merchantUser.role);
    if (!role.success) throw new SessionInvalidError();

    await client.query('select set_config($1, $2, true)', ['app.merchant_id', merchantUser.merchant_id]);

    await client.query(
      `update taply.merchant_sessions
       set last_seen_at = now(),
           idle_expires_at = least(now() + make_interval(secs => $2), absolute_expires_at),
           updated_at = now()
       where id = $1`,
      [session.id, idleSeconds],
    );

    const principal: AuthenticatedPrincipal = {
      sessionId: session.id,
      merchantId: merchantUser.merchant_id,
      merchantUserId: merchantUser.id,
      authUserId: session.auth_user_id,
      role: role.data,
    };

    return fn(client, principal);
  });
}

/**
 * Résolution pré-session : à partir d'un auth_user_id Supabase (jamais
 * d'un merchantId/role envoyé par le client), trouve le mapping merchant
 * actif correspondant — ou rien. Utilisé uniquement par le flux de login,
 * avant qu'une session Taply n'existe.
 */
export async function resolveMerchantUserByAuthId(pool: Pool, authUserId: string): Promise<MerchantUserMapping | undefined> {
  const parsed = uuidSchema.safeParse(authUserId);
  if (!parsed.success) throw new AuthInvalidCredentialsError();

  return withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.auth_user_id', parsed.data]);

    const result = await client.query<MerchantUserRow>(
      `select id, merchant_id, role, status
       from taply.merchant_users
       where auth_user_id = $1 and status = 'active'`,
      [parsed.data],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;

    const role = roleSchema.safeParse(row.role);
    if (!role.success) return undefined;

    return { id: row.id, merchantId: row.merchant_id, role: role.data };
  });
}

export interface CreateLoginSessionParams {
  readonly merchantId: string;
  readonly merchantUserId: string;
  readonly authUserId: string;
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
}

export interface CreatedSession {
  readonly rawToken: string;
  readonly sessionId: string;
}

/**
 * Crée une nouvelle session Taply pour une identité déjà résolue et
 * active (jamais appelé avec des valeurs venant du client). Pose
 * app.auth_user_id ET app.merchant_id avant l'INSERT — exigés tous les
 * deux par la policy `insert_own_session`.
 */
export async function createLoginSession(pool: Pool, params: CreateLoginSessionParams): Promise<CreatedSession> {
  return withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.auth_user_id', params.authUserId]);
    await client.query('select set_config($1, $2, true)', ['app.merchant_id', params.merchantId]);

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);

    const result = await client.query<{ id: string }>(
      `insert into taply.merchant_sessions
         (merchant_id, merchant_user_id, auth_user_id, token_hash, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, $4, now() + make_interval(secs => $5), now() + make_interval(secs => $6))
       returning id`,
      [params.merchantId, params.merchantUserId, params.authUserId, tokenHash, params.idleSeconds, params.absoluteSeconds],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('merchant_sessions insert returned no row');

    return { rawToken, sessionId: row.id };
  });
}

/**
 * Révoque une session par son jeton brut — idempotent par construction :
 * si le jeton ne correspond à rien (déjà révoqué, expiré, ou jamais
 * existé), l'UPDATE ne touche aucune ligne et on ne lève rien. L'appelant
 * HTTP ne doit jamais traduire "0 ligne affectée" en une réponse
 * différente de "déjà déconnecté" — pas de fuite d'existence de session.
 */
export async function revokeSession(pool: Pool, rawSessionToken: string): Promise<void> {
  const tokenHash = hashSessionToken(rawSessionToken);

  await withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.session_token_hash', tokenHash]);
    await client.query(
      `update taply.merchant_sessions
       set revoked_at = now(), updated_at = now()
       where token_hash = $1 and revoked_at is null`,
      [tokenHash],
    );
  });
}
