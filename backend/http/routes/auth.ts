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
import { AppError } from '../../core/errors.js';
import { originCheck } from '../origin.js';
import { dbPool, loyaltyEnabled } from '../gates.js';
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
  if (!loyaltyEnabled(cfg.appEnv)) throw new AppError('SERVICE_UNAVAILABLE');
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
  if (error?.status === 429) throw new AppError('RATE_LIMITED');
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
    const result = await loginWithPassword(dbPool(c), log, {
      email: parsed.data.email,
      password: parsed.data.password,
      idleSeconds: config.auth.sessionIdleSeconds,
      absoluteSeconds: config.auth.sessionAbsoluteSeconds,
      allowOnboarding: loyaltyEnabled(config.appEnv),
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
      dbPool(c),
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
    await revokeSession(dbPool(c), rawToken);
    c.get('log').info('auth.logout', {});
  }

  // Idempotent : cookie absent/invalide → même réponse, cookie effacé
  // quand même — jamais de fuite sur l'existence d'une session.
  clearSessionCookie(c, config.appEnv);
  return c.json({ loggedOut: true }, 200);
});

const emailOnlySchema = z.strictObject({ email: z.string().trim().max(255).pipe(z.email()) });

/**
 * Mot de passe oublié : Supabase envoie le lien. Réponse uniforme, que le
 * compte existe ou non (aucune énumération d'adresses).
 */
authRoutes.post('/auth/password/forgot', originCheck, async (c) => {
  const cfg = c.get('config');
  if (!cfg.auth.appOrigin) throw new AppError('SERVICE_UNAVAILABLE');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const parsed = emailOnlySchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');
  const { error } = await createAuthClient().auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: cfg.auth.appOrigin + '/reinitialiser-mot-de-passe.html',
  });
  if (error?.status === 429) throw new AppError('RATE_LIMITED');
  if (error) c.get('log').warn('auth.password_forgot.provider_failed', { status: error.status || 0 });
  return c.json({ emailSent: true }, 202);
});

/** Renvoi de l'e-mail de confirmation (même réponse uniforme). */
authRoutes.post('/auth/confirmation/resend', originCheck, async (c) => {
  const cfg = c.get('config');
  if (!cfg.auth.appOrigin) throw new AppError('SERVICE_UNAVAILABLE');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const parsed = emailOnlySchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');
  const { error } = await createAuthClient().auth.resend({
    type: 'signup', email: parsed.data.email,
    options: { emailRedirectTo: cfg.auth.appOrigin + '/connexion.html?confirmation=ok' },
  });
  if (error?.status === 429) throw new AppError('RATE_LIMITED');
  return c.json({ emailSent: true }, 202);
});

const resetSchema = z.strictObject({
  accessToken: z.string().min(20).max(4096).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(12).max(128),
});

/**
 * Nouveau mot de passe depuis le lien de récupération Supabase. Le jeton
 * d'accès de récupération (fragment d'URL, jamais envoyé au serveur par le
 * navigateur lors de la navigation) est transmis ici par POST et vérifié
 * par Supabase. Aucune session Taply n'est ouverte automatiquement.
 */
authRoutes.post('/auth/password/reset', originCheck, async (c) => {
  const cfg = c.get('config');
  if (!cfg.auth.supabaseUrl || !cfg.auth.supabasePublishableKey) throw new AppError('SERVICE_UNAVAILABLE');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const parsed = resetSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');
  const response = await fetch(cfg.auth.supabaseUrl + '/auth/v1/user', {
    method: 'PUT',
    headers: {
      apikey: cfg.auth.supabasePublishableKey,
      Authorization: 'Bearer ' + parsed.data.accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: parsed.data.password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) throw new AppError('AUTH_INVALID', { userMessage: 'Lien expiré ou déjà utilisé.' });
  if (response.status === 422) throw new AppError('VALIDATION_FAILED', { userMessage: 'Mot de passe refusé : choisissez-en un autre.' });
  if (response.status === 429) throw new AppError('RATE_LIMITED');
  if (!response.ok) throw new AppError('SERVICE_UNAVAILABLE');
  c.get('log').info('auth.password_reset.done', {});
  return c.json({ updated: true });
});
