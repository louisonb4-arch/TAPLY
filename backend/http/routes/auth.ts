/**
 * Routes Auth — POST /auth/login, GET /auth/me, POST /auth/logout.
 *
 * Jamais de merchantId/role/authUserId en entrée : tout est dérivé côté
 * serveur depuis le cookie de session (voir backend/auth/session.ts).
 * Jamais le corps de requête journalisé (email/mot de passe). Réponses
 * d'échec volontairement génériques — voir backend/auth/errors.ts.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { setSessionCookie, clearSessionCookie, getSessionCookie } from '../../auth/cookie.js';
import { AuthInvalidCredentialsError, SessionInvalidError } from '../../auth/errors.js';
import { loginWithPassword } from '../../auth/login.js';
import { revokeSession, withAuthenticatedTx } from '../../auth/session.js';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../core/errors.js';
import { originCheck } from '../origin.js';
import type { AppEnvBindings } from '../types.js';

export const authRoutes = new Hono<AppEnvBindings>();

const loginBodySchema = z.object({
  email: z.string().trim().min(1).max(255).pipe(z.email()),
  password: z.string().min(1).max(512),
});

// originCheck passé explicitement par route (jamais un `.use('*', …)` sur
// ce sous-routeur : mettre login et health au même point de montage `/`
// ferait fuiter le middleware vers des routes non-Auth — vérifié). Login
// inclus : une mutation vulnérable au login-CSRF comme une autre.
authRoutes.post('/auth/login', originCheck, async (c) => {
  const config = c.get('config');
  const log = c.get('log');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError('VALIDATION_FAILED');
  }

  const parsed = loginBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');

  try {
    const result = await loginWithPassword(getPool(), log, {
      email: parsed.data.email,
      password: parsed.data.password,
      idleSeconds: config.auth.sessionIdleSeconds,
      absoluteSeconds: config.auth.sessionAbsoluteSeconds,
    });

    setSessionCookie(c, config.appEnv, result.rawToken, config.auth.sessionAbsoluteSeconds);

    return c.json({ authenticated: true, merchantId: result.merchantId, role: result.role }, 200);
  } catch (error) {
    if (error instanceof AuthInvalidCredentialsError) {
      throw new AppError('AUTH_INVALID');
    }
    throw error;
  }
});

authRoutes.get('/auth/me', async (c) => {
  const config = c.get('config');
  const rawToken = getSessionCookie(c, config.appEnv);
  if (rawToken === undefined) throw new AppError('AUTH_REQUIRED');

  try {
    const principal = await withAuthenticatedTx(
      getPool(),
      rawToken,
      config.auth.sessionIdleSeconds,
      async (_client, p) => p,
    );
    return c.json({ authenticated: true, merchantId: principal.merchantId, role: principal.role }, 200);
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      c.get('log').info('auth.session.invalid', {});
      throw new AppError('AUTH_REQUIRED');
    }
    throw error;
  }
});

authRoutes.post('/auth/logout', originCheck, async (c) => {
  const config = c.get('config');
  const rawToken = getSessionCookie(c, config.appEnv);

  if (rawToken !== undefined) {
    await revokeSession(getPool(), rawToken);
    c.get('log').info('auth.logout', {});
  }

  // Idempotent : cookie absent/invalide → même réponse, cookie effacé
  // quand même — jamais de fuite sur l'existence d'une session.
  clearSessionCookie(c, config.appEnv);
  return c.json({ loggedOut: true }, 200);
});
