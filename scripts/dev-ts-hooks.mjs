/**
 * Développement local uniquement : permet à Node 24 d'exécuter directement
 * les sources TypeScript (suppression native des types, sans compilation).
 *
 * Le code importe `./module.js` (convention NodeNext, compilée telle quelle
 * par Vercel). En local, ce fichier n'existe pas : on résout vers `./module.ts`.
 * Aucun effet en production (Vercel compile api/ avec son propre builder).
 */

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
