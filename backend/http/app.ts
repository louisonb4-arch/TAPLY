/**
 * Application Hono — uniquement l'API (/api/*).
 *
 * Le site statique n'est jamais servi par Hono : Vercel le sert directement
 * depuis la racine du dépôt (voir vercel.json, preset « Other »).
 *
 * Ordre des middlewares (phase 1) :
 *   contexte → requestId → journal de requête → en-têtes de sécurité
 *   → Cache-Control no-store → limite de corps → routes
 * Les contrôles Origin / session / autorisation / rate limit arrivent avec
 * l'auth (phase 3) ; aucune route mutante n'existe en phase 1.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppConfig } from '../core/config.js';
import { AppError, isAppError, toErrorBody, type ErrorCode } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { requestIdMiddleware } from './request-id.js';
import { healthRoutes } from './routes/health.js';
import type { AppEnvBindings } from './types.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
}

export const API_BASE_PATH = '/api';

function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

export function createApp(deps: AppDependencies): Hono<AppEnvBindings> {
  const app = new Hono<AppEnvBindings>().basePath(API_BASE_PATH);

  app.use('*', async (c, next) => {
    c.set('config', deps.config);
    c.set('rootLog', deps.logger);
    await next();
  });

  app.use('*', requestIdMiddleware);

  app.use('*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    // Chemin seul (jamais la query string, qui peut contenir des secrets).
    c.get('log').info('http.request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
      vercelId: c.req.header('x-vercel-id') ?? null,
    });
  });

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      crossOriginResourcePolicy: 'same-origin',
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
    }),
  );

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: deps.config.api.bodyLimitBytes,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE');
      },
    }),
  );

  app.route('/', healthRoutes);

  app.notFound((c) => {
    const error = new AppError('NOT_FOUND');
    c.header('Cache-Control', 'no-store');
    return c.json(toErrorBody(error, c.get('requestId')), error.status);
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId');
    const log = c.get('log');

    let error: AppError;
    if (isAppError(err)) {
      error = err;
    } else if (err instanceof HTTPException) {
      error = new AppError(codeForHttpStatus(err.status), { cause: err });
    } else {
      error = new AppError('INTERNAL_ERROR', { cause: err });
    }

    const fields = { code: error.code, status: error.status, ...error.logContext, cause: error.cause ?? err };
    if (error.status >= 500) log.error('http.error', fields);
    else log.warn('http.error', fields);

    c.header('Cache-Control', 'no-store');
    return c.json(toErrorBody(error, requestId), error.status);
  });

  return app;
}
