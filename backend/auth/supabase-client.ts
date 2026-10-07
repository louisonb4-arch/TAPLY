/**
 * Client Supabase Auth, clé PUBLISHABLE uniquement — jamais service_role,
 * jamais SUPABASE_SECRET_KEY. La vérification de mot de passe ne demande
 * aucune clé élevée.
 *
 * Toujours une instance NEUVE, jamais un singleton de portée module.
 * `persistSession: false` empêche seulement l'écriture vers un storage
 * (non pertinent côté serveur) — l'état de session reste en mémoire sur
 * l'INSTANCE du client. Un singleton partagé entre requêtes concurrentes
 * sur une même instance Vercel (Fluid Compute) pourrait faire porter
 * l'état d'authentification d'un appelant vers un autre. Construire un
 * client neuf par connexion n'ouvre aucune connexion réseau — coût
 * négligeable, risque éliminé.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../core/config.js';
import { AuthConfigError } from './errors.js';

export function createAuthClient(): SupabaseClient {
  const { auth } = getConfig();
  if (auth.supabaseUrl === undefined || auth.supabasePublishableKey === undefined) {
    throw new AuthConfigError('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY manquants : Auth non configuré.');
  }

  return createClient(auth.supabaseUrl, auth.supabasePublishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
