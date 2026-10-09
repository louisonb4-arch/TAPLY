/**
 * Portes d'activation des fonctionnalités Taply.
 *
 * Préproduction : TAPLY_LOYALTY_PREVIEW=enabled (+ TAPLY_QR_ANONYMOUS_V1
 * pour l'API client publique).
 * Production : désactivé par défaut. N'ouvre qu'avec la décision explicite
 * TAPLY_PRODUCTION_RELEASE=v1-approved (posée par le propriétaire du
 * produit, jamais par défaut). Un APP_ENV mal réglé ne peut pas ouvrir la
 * production : VERCEL_ENV=production est vérifié indépendamment.
 */
import type { Context } from 'hono';
import type { Pool } from 'pg';
import { AppError } from '../core/errors.js';
import { getPool } from '../db/pool.js';
import type { AppEnvBindings } from './types.js';

type Env = Readonly<Record<string, string | undefined>>;

export function isProductionRuntime(appEnv: string, env: Env = process.env): boolean {
  return appEnv === 'production' || env['VERCEL_ENV'] === 'production';
}

export function loyaltyEnabled(appEnv: string, env: Env = process.env): boolean {
  if (isProductionRuntime(appEnv, env)) return env['TAPLY_PRODUCTION_RELEASE'] === 'v1-approved';
  return env['TAPLY_LOYALTY_PREVIEW'] === 'enabled';
}

export function customerApiEnabled(appEnv: string, env: Env = process.env): boolean {
  if (!loyaltyEnabled(appEnv, env)) return false;
  return isProductionRuntime(appEnv, env) || env['TAPLY_QR_ANONYMOUS_V1'] === 'enabled';
}

export function checkLoyalty(c: { get(name: 'config'): { appEnv: string } }): void {
  if (!loyaltyEnabled(c.get('config').appEnv)) throw new AppError('SERVICE_UNAVAILABLE');
}

export function checkCustomerApi(c: { get(name: 'config'): { appEnv: string } }): void {
  if (!customerApiEnabled(c.get('config').appEnv)) throw new AppError('SERVICE_UNAVAILABLE');
}

export function dbPool(c: Context<AppEnvBindings>): Pool {
  return c.get('dbPool') ?? getPool();
}

/** Cookies Secure dès qu'on n'est plus en local/test. */
export function secureCookies(appEnv: string): boolean {
  return appEnv === 'staging' || appEnv === 'production';
}
