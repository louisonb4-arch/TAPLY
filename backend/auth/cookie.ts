/**
 * Cookie de session Taply — jamais de JWT, jamais de JSON, jamais de
 * merchantId/role/authUserId dedans : uniquement le jeton opaque brut.
 *
 * `__Host-` en staging/production : exige Secure + Path=/ + aucun
 * attribut Domain — Hono (`hono/cookie`, `prefix: 'host'`) les impose
 * automatiquement, donc on ne les répète jamais à la main ici (pas de
 * risque de divergence). En développement local (pas de HTTPS), un nom
 * de cookie simple est utilisé — jamais en staging/production : on
 * n'affaiblit jamais leur comportement pour le confort de `localhost`.
 */

import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv } from '../core/config.js';
import type { AppEnvBindings } from '../http/types.js';

const COOKIE_NAME = 'taply_session';

function usesHostPrefix(appEnv: AppEnv): boolean {
  return appEnv === 'staging' || appEnv === 'production';
}

export function getSessionCookie(c: Context<AppEnvBindings>, appEnv: AppEnv): string | undefined {
  return usesHostPrefix(appEnv) ? getCookie(c, COOKIE_NAME, 'host') : getCookie(c, COOKIE_NAME);
}

/** `maxAgeSeconds` ne doit jamais dépasser la durée de vie absolue de la session. */
export function setSessionCookie(c: Context<AppEnvBindings>, appEnv: AppEnv, rawToken: string, maxAgeSeconds: number): void {
  if (usesHostPrefix(appEnv)) {
    // prefix: 'host' force déjà secure: true, path: '/', domain: undefined.
    setCookie(c, COOKIE_NAME, rawToken, { httpOnly: true, sameSite: 'Lax', maxAge: maxAgeSeconds, prefix: 'host' });
  } else {
    setCookie(c, COOKIE_NAME, rawToken, {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: maxAgeSeconds,
      path: '/',
      secure: false,
    });
  }
}

export function clearSessionCookie(c: Context<AppEnvBindings>, appEnv: AppEnv): void {
  if (usesHostPrefix(appEnv)) {
    deleteCookie(c, COOKIE_NAME, { prefix: 'host' });
  } else {
    deleteCookie(c, COOKIE_NAME, { path: '/' });
  }
}
