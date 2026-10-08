/**
 * scanWalletQrAndCredit — orchestre résolution QR + crédit visite.
 *
 * Service INTERNE appelé par la couche HTTP (withAuthenticatedTx).
 * Reçoit un PoolClient DÉJÀ dans une transaction authentifiée et un
 * principal dérivé côté serveur. N'ouvre jamais de transaction, n'émet
 * aucune requête externe.
 *
 * Flux :
 *   1. Vérification rôle owner/staff (zéro SELECT si refusé)
 *   2. resolveWalletQrToken → membershipId (zéro mutation si invalide)
 *   3. creditVisit avec membershipId résolu côté serveur, source QR_EMPLOYEE
 *
 * Sécurité :
 *   - Aucun membershipId, merchantId, source ou timestamp client en entrée
 *   - Le jeton brut n'est jamais loggé ni retourné
 *   - QR invalide retourne un code générique (pas de fuite PII/token)
 *   - Aucun endpoint public — le scan requiert rôle owner/staff
 *   - Le hash at rest empêche reconstruction brut via DB mais NE protège
 *     PAS contre replay screenshot (mitigation hors périmètre)
 *
 * NON ACTIVABLE EN PRODUCTION avant :
 *   - PIN + device approval sur validation employé
 *   - Tests PostgreSQL réels (RLS, verrous, contraintes)
 */

import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { creditVisit } from './credit.js';
import type { CreditVisitResult } from './credit.js';
import { resolveWalletQrToken } from './qr-token.js';

// ── Types ────────────────────────────────────────────────────────────

export type ScanResult =
  | CreditVisitResult
  | { readonly credited: false; readonly reason: ScanDenialReason };

export type ScanDenialReason =
  | { readonly kind: 'unauthorized_role' }
  | { readonly kind: 'qr_invalid' };

// ── Fonction principale ──────────────────────────────────────────────

export async function scanWalletQrAndCredit(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  rawQrToken: string,
  idempotencyKey: string,
): Promise<ScanResult> {
  // ── 1. Vérification rôle AVANT toute requête SQL ──────────────────
  if (principal.role !== 'owner' && principal.role !== 'staff') {
    return { credited: false, reason: { kind: 'unauthorized_role' } };
  }

  // ── 2. Résolution QR → membershipId (zéro mutation si invalide) ───
  const membershipId = await resolveWalletQrToken(client, principal, rawQrToken);

  if (membershipId === undefined) {
    // Code générique : pas de fuite sur la raison exacte (format, révoqué,
    // mauvais merchant, inactif…)
    return { credited: false, reason: { kind: 'qr_invalid' } };
  }

  // ── 3. Crédit visite — membershipId résolu côté serveur ───────────
  return creditVisit(client, principal, {
    membershipId,
    source: 'QR_EMPLOYEE',
    idempotencyKey,
  });
}
