/**
 * Limitation de débit des routes publiques (création d'identités/cartes,
 * récupération, NFC), stockée en base pour tenir sur plusieurs instances
 * serverless. Aucune IP en clair : HMAC-SHA256 poivré, domaine séparé.
 *
 * Le compteur s'incrémente AVANT la décision : une rafale concurrente ne
 * peut pas dépasser la limite (l'upsert est atomique sur la clé primaire).
 */
import { createHash, createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';

const DOMAIN = 'taply:rate:v1:';

function pepper(): string {
  return process.env['TAPLY_RATE_LIMIT_PEPPER'] ?? process.env['TAPLY_STAFF_PIN_PEPPER'] ?? DOMAIN;
}

/** Empreinte stable d'une adresse IP (jamais stockée ni journalisée en clair). */
export function hashClientIp(ip: string): string {
  return createHmac('sha256', pepper()).update(DOMAIN + 'ip:' + ip).digest('hex');
}

/**
 * IP cliente. Sur Vercel, `x-real-ip` est posé par l'edge (non falsifiable
 * par le client) ; en local il est absent.
 */
export function clientIp(header: (name: string) => string | undefined): string {
  const real = header('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = header('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : 'unknown';
}

/**
 * Consomme une unité sur la clé logique `scope` pendant une fenêtre fixe.
 * Retourne true si la requête reste dans la limite.
 */
export async function consumeRateLimit(
  client: PoolClient,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new RangeError('Paramètres de limitation invalides');
  }
  const keyHash = createHash('sha256').update(DOMAIN + scope).digest('hex');
  await client.query('select set_config($1, $2, true)', ['app.rate_key_hash', keyHash]);
  const result = await client.query<{ hits: number }>(
    `insert into taply.public_rate_buckets (key_hash, window_start, hits)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (key_hash, window_start)
       do update set hits = taply.public_rate_buckets.hits + 1
     returning hits`,
    [keyHash, windowSeconds],
  );
  const hits = result.rows[0]?.hits ?? Number.POSITIVE_INFINITY;
  return hits <= limit;
}
