/**
 * Primitive d'autorisation par rôle — V1 minimal.
 *
 * Hiérarchie explicite, volontairement plate : `owner` peut tout ce que
 * `staff` peut, plus les actions owner-only. Pas de matrice de
 * permissions à dizaines d'entrées — rien ne la justifie encore. Aucune
 * route owner-only n'existe dans cette phase : ceci est uniquement la
 * primitive, testée isolément.
 */

import { AuthForbiddenError } from './errors.js';
import type { MerchantRole } from './session.js';

const ROLE_RANK: Readonly<Record<MerchantRole, number>> = { staff: 0, owner: 1 };

export function roleSatisfies(actual: MerchantRole, required: MerchantRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Lève AuthForbiddenError si `actual` n'atteint pas `required`. */
export function requireRole(required: MerchantRole, actual: MerchantRole): void {
  if (!roleSatisfies(actual, required)) {
    throw new AuthForbiddenError(required);
  }
}
