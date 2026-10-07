/**
 * Jeton de session opaque Taply.
 *
 * Le jeton BRUT ne vit jamais en base — seule son empreinte SHA-256 (hex,
 * 64 caractères, vérifiée par CHECK en migration) y est stockée. Le brut
 * n'existe que :
 *  - temporairement en mémoire du processus serveur ;
 *  - dans le cookie HttpOnly du navigateur.
 * Jamais en base, logs, URL, ni stockage navigateur scriptable.
 */

import { createHash, randomBytes } from 'node:crypto';

const RAW_TOKEN_BYTES = 32; // 256 bits minimum.
const TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/;

/** Jeton brut, base64url, 256 bits d'entropie. */
export function generateSessionToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

/** Empreinte SHA-256 hex (toujours 64 caractères) du jeton brut. */
export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Vrai uniquement si la chaîne a exactement la forme d'une empreinte SHA-256 hex. */
export function isTokenHashShape(value: string): boolean {
  return TOKEN_HASH_SHAPE.test(value);
}
