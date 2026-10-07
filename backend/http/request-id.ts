/**
 * requestId : généré par le serveur pour chaque requête (UUID v4, CSPRNG).
 *
 * Un `X-Request-Id` fourni par le client n'est PAS repris (pas de confiance,
 * risque d'injection dans les logs). L'identifiant Vercel (`x-vercel-id`),
 * posé par l'infrastructure, est seulement journalisé à titre de corrélation.
 */

import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppEnvBindings } from './types.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

export function generateRequestId(): string {
  return randomUUID();
}

export const requestIdMiddleware = createMiddleware<AppEnvBindings>(async (c, next) => {
  const requestId = generateRequestId();
  c.set('requestId', requestId);
  c.set('log', c.get('rootLog').child({ requestId }));
  c.header(REQUEST_ID_HEADER, requestId);
  await next();
});
