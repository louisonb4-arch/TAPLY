/**
 * Défense CSRF par Origin exacte — pas une alternative à SameSite/CORS,
 * une couche indépendante en plus. S'applique aux routes authentifiées
 * par cookie (voir backend/http/routes/auth.ts, qui monte ce middleware
 * sur lui-même) pour toute méthode mutante (POST/PUT/PATCH/DELETE) —
 * login et logout inclus (login-CSRF). Pas un middleware global sur
 * toute l'API : les routes non liées à l'Auth/au cookie n'ont pas ce
 * contrat.
 *
 * Fail-closed explicite : Origin absente, malformée, ou différente par
 * schéma/hôte/port → rejet. Configuration APP_ORIGIN absente → rejet de
 * TOUTE mutation (jamais un contournement silencieux faute de config).
 */

import type { MiddlewareHandler } from 'hono';
import { AppError } from '../core/errors.js';
import type { AppEnvBindings } from './types.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const originCheck: MiddlewareHandler<AppEnvBindings> = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const expectedOrigin = c.get('config').auth.appOrigin;
  const origin = c.req.header('origin');
  const rejected = expectedOrigin === undefined || origin === undefined || origin !== expectedOrigin;

  if (rejected) {
    c.get('log').warn('auth.origin.rejected', {
      method: c.req.method,
      path: c.req.path,
      hasOrigin: origin !== undefined,
      hasExpectedOrigin: expectedOrigin !== undefined,
    });
    throw new AppError('ORIGIN_REJECTED');
  }

  await next();
};
