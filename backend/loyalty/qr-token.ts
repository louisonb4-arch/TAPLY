/**
 * Identité QR Wallet opaque — génération, hashing et résolution.
 *
 * Chaque membre reçoit un jeton QR unique (32 bytes de randomness,
 * base64url, sans PII). Seul le hash SHA-256 domain-separated est stocké
 * en base (`wallet_qr_token_hash` dans `taply.wallet_qr_tokens`). Le brut n'existe que
 * temporairement en mémoire serveur et dans le QR affiché au membre.
 *
 * LIMITES CONNUES : le hash at rest empêche la reconstruction du jeton brut
 * à partir de la base, mais NE protège PAS contre la copie physique,
 * le screenshot, ou le replay du QR par un tiers qui le possède. La
 * mitigation replay (PIN, device binding, NFC) est hors périmètre ici.
 *
 * Ce module ne crée aucun endpoint, n'effectue aucune opération de crédit,
 * et ne gère pas le QR public du présentoir (canal distinct).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';

// ── Constants ───────────────────────────────────────────────────────

const RAW_TOKEN_BYTES = 32; // 256 bits
const DOMAIN_SEPARATOR = 'taply:wallet-qr:v1:';

/**
 * Format strict du jeton brut base64url : exactement la longueur produite
 * par 32 bytes encodés base64url (43 caractères, sans padding).
 * Regex : alphabet base64url uniquement, longueur fixe.
 */
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/;

// ── Generation ──────────────────────────────────────────────────────

/** Jeton brut base64url, 256 bits d'entropie. */
export function generateWalletQrToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

// ── Hashing (domain-separated) ──────────────────────────────────────

/**
 * SHA-256 domain-separated : `H("taply:wallet-qr:v1:" || rawToken)`.
 * Le préfixe sépare ce type de jeton des sessions (domain separation).
 */
export function hashWalletQrToken(rawToken: string): string {
  return createHash('sha256')
    .update(DOMAIN_SEPARATOR + rawToken, 'utf8')
    .digest('hex');
}

// ── Format validation ───────────────────────────────────────────────

export function isValidWalletQrToken(value: string): boolean {
  return RAW_TOKEN_PATTERN.test(value);
}

export function isWalletQrTokenHashShape(value: string): boolean {
  return TOKEN_HASH_SHAPE.test(value);
}

// ── Resolution ──────────────────────────────────────────────────────

/**
 * Résout un jeton QR Wallet brut → membershipId.
 *
 * Préconditions :
 *   - `client` est un PoolClient DÉJÀ dans une transaction authentifiée
 *     (GUC app.merchant_id posé par withAuthenticatedTx).
 *   - `principal` est dérivé côté serveur, jamais du client HTTP.
 *
 * Retourne le membershipId si et seulement si :
 *   1. Format du jeton valide (sinon aucune requête SQL émise)
 *   2. token_hash exact match sur wallet_qr_tokens
 *   3. membership.merchant_id = principal.merchantId (jointure explicite)
 *   4. revoked_at IS NULL sur le jeton (non révoqué)
 *   5. membership, program et merchant tous actifs (jointures explicites)
 *
 * RLS (app.merchant_id) constitue une seconde couche indépendante —
 * les filtres applicatifs explicites ci-dessus ne s'y fient jamais seuls.
 * Ce module ne certifie pas la RLS.
 *
 * Le jeton brut n'apparaît JAMAIS dans la requête SQL ni dans la valeur
 * de retour — seul le hash est transmis comme paramètre.
 */

const RESOLVE_QUERY = `
  select m.id as membership_id
  from taply.wallet_qr_tokens t
  join taply.memberships m
    on m.id = t.membership_id
   and m.merchant_id = t.merchant_id
  join taply.loyalty_programs lp
    on lp.id = m.program_id
   and lp.merchant_id = m.merchant_id
  join taply.merchants mer
    on mer.id = m.merchant_id
  where t.token_hash = $1
    and t.merchant_id = $2
    and m.merchant_id = $2
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > now())
    and m.status = 'active'
    and lp.status = 'active'
    and mer.status = 'active'
  for share of t
` as const;

interface ResolveRow {
  readonly membership_id: string;
}

export async function resolveWalletQrToken(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  rawToken: string,
): Promise<string | undefined> {
  // Format gate — aucune requête SQL si format invalide.
  if (!isValidWalletQrToken(rawToken)) {
    return undefined;
  }

  const tokenHash = hashWalletQrToken(rawToken);

  const result = await client.query<ResolveRow>(RESOLVE_QUERY, [
    tokenHash,
    principal.merchantId,
  ]);

  const row = result.rows[0];
  return row?.membership_id;
}
