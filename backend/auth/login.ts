/**
 * Orchestration du login — séparée de la couche HTTP pour rester
 * testable sans serveur. Toute erreur ici doit être `AuthInvalidCredentialsError`
 * — jamais une distinction observable entre « compte inconnu », « mot de
 * passe incorrect », « mapping merchant absent » ou « mapping désactivé ».
 */

import type { Pool } from 'pg';
import type { Logger } from '../core/logger.js';
import { AuthInvalidCredentialsError } from './errors.js';
import { createLoginSession, resolveMerchantUserByAuthId, type MerchantRole } from './session.js';
import { createAuthClient } from './supabase-client.js';

export interface LoginParams {
  readonly email: string;
  readonly password: string;
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
}

export interface LoginResult {
  readonly rawToken: string;
  readonly merchantId: string;
  readonly role: MerchantRole;
}

export async function loginWithPassword(pool: Pool, log: Logger, params: LoginParams): Promise<LoginResult> {
  const client = createAuthClient();

  const { data, error } = await client.auth.signInWithPassword({
    email: params.email,
    password: params.password,
  });

  if (error || data.user === null) {
    log.info('auth.login.failed', { reason: 'supabase_rejected' });
    throw new AuthInvalidCredentialsError();
  }

  const authUserId = data.user.id;

  // Nettoyage immédiat de la session Supabase temporaire — scope 'local'
  // explicitement, JAMAIS le scope global par défaut (qui invaliderait
  // toutes les sessions Supabase Auth de cette identité, pas seulement
  // celle-ci). Un échec de ce nettoyage n'est pas fatal : aucun token
  // Supabase n'est jamais persisté ou renvoyé au navigateur de toute
  // façon ; c'est seulement journalisé pour observabilité.
  const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
  if (signOutError) {
    log.warn('auth.supabase_cleanup_failed', { message: signOutError.message });
  }

  const merchantUser = await resolveMerchantUserByAuthId(pool, authUserId);
  if (merchantUser === undefined) {
    log.info('auth.login.failed', { reason: 'no_active_mapping' });
    throw new AuthInvalidCredentialsError();
  }

  const { rawToken } = await createLoginSession(pool, {
    merchantId: merchantUser.merchantId,
    merchantUserId: merchantUser.id,
    authUserId,
    idleSeconds: params.idleSeconds,
    absoluteSeconds: params.absoluteSeconds,
  });

  log.info('auth.login.success', { merchantId: merchantUser.merchantId, role: merchantUser.role });

  return { rawToken, merchantId: merchantUser.merchantId, role: merchantUser.role };
}
