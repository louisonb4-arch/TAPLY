/**
 * GET /api/health — vivacité de l'API.
 *
 * Phase 1 : aucune dépendance externe (pas de base de données) ; la réponse
 * indique seulement que la Function répond. Ne révèle ni configuration,
 * ni version de dépendances, ni secret.
 */

import { Hono } from 'hono';
import type { AppEnvBindings } from '../types.js';

export interface HealthBody {
  readonly status: 'ok';
  readonly service: 'taply-api';
  readonly time: string;
  readonly requestId: string;
}

export const healthRoutes = new Hono<AppEnvBindings>();

healthRoutes.get('/health', (c) => {
  const body: HealthBody = {
    status: 'ok',
    service: 'taply-api',
    time: new Date().toISOString(),
    requestId: c.get('requestId'),
  };
  return c.json(body, 200);
});
