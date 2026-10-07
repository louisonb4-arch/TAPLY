/**
 * Construction de l'application pour le runtime Vercel.
 *
 * Instanciée une seule fois par instance (portée module). Si la configuration
 * est invalide, l'erreur est journalisée (sans valeurs) et chaque requête
 * reçoit une 503 générique : le site statique, servi par Vercel, n'est pas
 * affecté.
 */

import { getConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { createApp } from './app.js';

export type FetchHandler = (request: Request) => Response | Promise<Response>;

function unavailable(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Service momentanément indisponible.', requestId: null },
    }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' } },
  );
}

export function buildFetchHandler(): FetchHandler {
  try {
    const config = getConfig();
    const logger = createLogger({ level: config.logLevel, base: { service: 'taply-api', env: config.appEnv } });
    const app = createApp({ config, logger });
    return (request) => app.fetch(request);
  } catch (error) {
    const logger = createLogger({ level: 'error', base: { service: 'taply-api' } });
    logger.error('startup.failed', {
      reason: error instanceof ConfigError ? 'invalid_config' : 'unexpected',
      issues: error instanceof ConfigError ? error.issues : undefined,
      cause: error instanceof ConfigError ? undefined : error,
    });
    return unavailable;
  }
}
