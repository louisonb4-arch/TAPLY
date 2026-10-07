/**
 * Vercel Function unique de l'API Taply (runtime Node.js).
 *
 * vercel.json réécrit /api/* vers cette Function ; Hono route ensuite sur le
 * chemin d'origine (basePath /api). Le site statique n'est pas concerné.
 */

import { buildFetchHandler } from '../backend/http/bootstrap.js';

const handle = buildFetchHandler();

export default {
  fetch(request: Request): Response | Promise<Response> {
    return handle(request);
  },
};
