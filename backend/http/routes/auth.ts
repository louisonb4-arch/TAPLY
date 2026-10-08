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
import { createAuthClient } from '../../auth/supabase-client.js';
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

const signupBodySchema = z.strictObject({
  businessName: z.string().trim().min(2).max(80).refine(n => !/[\x00-\x1F\x7F]/.test(n)),
  email: z.string().trim().max(255).pipe(z.email()),
  password: z.string().min(12).max(128),
  termsAccepted: z.literal(true),
});

/**
 * Inscription commerçant en préproduction uniquement.
 * Seul Supabase gère le mot de passe et l'envoi de la confirmation.
 * Le rattachement au commerce intervient APRÈS vérification de l'email,
 * au premier login, grâce au JWT Supabase (voir login.ts / RPC).
 */
authRoutes.post('/auth/signup', originCheck, async (c) => {
  const cfg = c.get('config');
  if (cfg.appEnv === 'production' || process.env['VERCEL_ENV'] === 'production' ||
      process.env['TAPLY_LOYALTY_PREVIEW'] !== 'enabled') {
    throw new AppError('SERVICE_UNAVAILABLE');
  }
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const parsed = signupBodySchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');
  if (!cfg.auth.appOrigin) throw new AppError('SERVICE_UNAVAILABLE');

  const client = createAuthClient();
  const { error } = await client.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: cfg.auth.appOrigin + '/connexion.html?confirmation=ok',
      data: {
        taply_onboarding_v1: true,
        taply_business_name: parsed.data.businessName,
      },
    },
  });
  if (error?.status === 429) {
    // Code provider non personnel : permet de distinguer le quota
    // global d'emails du quota par IP, sans journaliser email ou mot de passe.
    c.get('log').warn('auth.signup.provider_rate_limited', {
      providerCode: error.code ?? 'unspecified',
    });
    throw new AppError('RATE_LIMITED');
  }
  if (error && !['User already registered', 'Email address already registered'].some(
      m => error.message.includes(m))) {
    c.get('log').warn('auth.signup.provider_failed', { status: error.status || 0 });
    throw new AppError('SERVICE_UNAVAILABLE');
  }
  // Uniforme : un email déjà inscrit ne révèle pas l'existence de son compte.
  return c.json({ emailSent: true }, 202);
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
      allowOnboarding: config.appEnv !== 'production' &&
        process.env['VERCEL_ENV'] !== 'production' &&
        process.env['TAPLY_LOYALTY_PREVIEW'] === 'enabled',
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
