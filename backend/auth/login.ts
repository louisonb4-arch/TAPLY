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
  readonly allowOnboarding?: boolean;
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

  let merchantUser;
  try {
    merchantUser = await resolveMerchantUserByAuthId(pool, authUserId);

    // Seuls les comptes créés via l'inscription Taply, e-mail CONFIRMÉ,
    // peuvent provisionner leur propre boutique au premier login.
    // L'API RPC reçoit le JWT de l'utilisateur connecté depuis Supabase,
    // calcule auth.uid() en SQL et ignore tout authUserId arbitraire.
    if (!merchantUser && params.allowOnboarding === true &&
        data.user.email_confirmed_at &&
        data.user.user_metadata?.['taply_onboarding_v1'] === true) {
      const { error: provisioningError } = await client.rpc('taply_complete_merchant_signup_v1');
      if (provisioningError) {
        log.warn('auth.signup.provision_failed', { code: provisioningError.code || 'unknown' });
      } else {
        merchantUser = await resolveMerchantUserByAuthId(pool, authUserId);
      }
    }
  } finally {
    // Scope local seulement, JAMAIS global (ne déconnecte pas les autres
    // sessions Supabase). Aucun JWT Supabase renvoyé au navigateur Taply.
    const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
    if (signOutError) {
      log.warn('auth.supabase_cleanup_failed', { message: signOutError.message });
    }
  }

  if (!merchantUser) {
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
