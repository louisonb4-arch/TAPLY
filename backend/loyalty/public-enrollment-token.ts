/**
 * QR d'inscription public Taply : génération cryptographique et validation.
 *
 * Le token est public (photographiable), mais non devinable. Le POS et les
 * crédits de visites ne doivent JAMAIS accepter ce token comme autorisation.
 * Le parcours anonyme doit contrôler séparément le statut de publication.
 */
import { createHash, randomBytes } from 'node:crypto';

// 24 octets aléatoires = 192 bits, au-delà du minimum de 160 bits demandé.
const PUBLIC_TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PUBLIC_TOKEN_DOMAIN = 'taply:public-enrollment:v1:';

export function generateMerchantEnrollmentToken(): string {
  return randomBytes(PUBLIC_TOKEN_BYTES).toString('base64url');
}

export function isMerchantEnrollmentToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** Empreinte candidate pour un futur lookup haché : non branchée en base V1. */
export function hashMerchantEnrollmentToken(raw: string): string {
  if (!isMerchantEnrollmentToken(raw)) throw new TypeError('Invalid public token');
  return createHash('sha256').update(PUBLIC_TOKEN_DOMAIN + raw).digest('hex');
}

export function merchantEnrollmentUrl(origin: string, token: string): string {
  if (!isMerchantEnrollmentToken(token)) throw new TypeError('Invalid public token');
  const base = new URL(origin);
  // Seul le domaine HTTPS de confiance doit être passé (provenant de la config,
  // JAMAIS de l'en-tête Host / du client).
  if (base.protocol !== 'https:' || base.username || base.password
      || base.search || base.hash || base.pathname !== '/') {
    throw new TypeError('A clean HTTPS application origin is required');
  }
  return new URL('/j/' + token, base).href;
}
