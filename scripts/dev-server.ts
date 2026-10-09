/**
 * Serveur de développement local (jamais utilisé par Vercel).
 *
 *   npm run dev:api   → API seule : la vraie application Hono via api/index.ts
 *   npm run dev       → site (dist/) + API sur la même origine,
 *                       même ordre de routage que vercel.json :
 *                       fichiers statiques → /api/* → 404 (404.html)
 *
 * Écoute uniquement sur 127.0.0.1. Variables : PORT (défaut 3000),
 * SITE_DIR (défaut dist, mode complet uniquement).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import api from '../api/index.js';

export interface DevAppOptions {
  /** Dossier du site statique ; absent = API seule. */
  readonly siteDir?: string;
}

export function createDevApp({ siteDir }: DevAppOptions = {}): Hono {
  const app = new Hono();
  // Même point d'entrée que la Vercel Function.
  const toApi = (request: Request): Response | Promise<Response> => api.fetch(request);
  app.all('/api', (c) => toApi(c.req.raw));
  app.all('/api/*', (c) => toApi(c.req.raw));

  if (siteDir !== undefined) {
    // Même réécriture que vercel.json : URL courte des puces NFC.
    app.get('/t', (c) => c.html(readFileSync(join(siteDir, 't.html'), 'utf8')));
    app.use('*', serveStatic({ root: siteDir }));
    const notFoundPage = readFileSync(join(siteDir, '404.html'), 'utf8');
    app.notFound((c) => c.html(notFoundPage, 404));
  }
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiOnly = process.argv.includes('--api-only');
  const port = Number(process.env['PORT'] ?? 3000);
  const siteDir = process.env['SITE_DIR'] ?? 'dist';
  const app = createDevApp(apiOnly ? {} : { siteDir });
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    const mode = apiOnly ? 'API seule' : `site (${siteDir}/) + API`;
    console.log(`dev-server: ${mode} sur http://127.0.0.1:${info.port}  —  GET /api/health`);
  });
}
