#!/usr/bin/env node
/**
 * Construit le dossier servi en statique par Vercel (`dist/`).
 *
 * Pourquoi : avec le preset « Other », Vercel sert TOUS les fichiers du
 * dossier de sortie. Si la racine du dépôt était servie, le code backend
 * (backend/*.ts, tests, tsconfig.json…) serait lisible publiquement.
 *
 * Principe : liste blanche explicite. Seuls les fichiers du site existant
 * sont copiés, à l'octet près. Tout nouveau fichier public doit être ajouté
 * ici (le test `repo-invariants` échoue sinon).
 *
 * Reproductible : `dist/` est supprimé puis recréé à chaque build, aucun
 * fichier d’une sortie précédente ne peut survivre (testé).
 *
 * Aucune transformation : copie binaire, mêmes chemins, mêmes URL.
 * Les Vercel Functions (api/) sont construites séparément par Vercel.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');

/** Fichiers et dossiers publics (relatifs à la racine du dépôt). */
export const PUBLIC_ENTRIES = Object.freeze([
  '404.html',
  'cgu.html',
  'cgv.html',
  'confidentialite.html',
  'connexion.html',
  'cookies.html',
  'index.html',
  'join.html',
  'mentions-legales.html',
  'robots.txt',
  'sitemap.xml',
  'css',
  'dashboard',
  'images',
  'js',
]);

/** Extensions interdites dans la sortie, même dans un dossier public. */
const FORBIDDEN_EXTENSIONS = ['.ts', '.mts', '.cts', '.map', '.env', '.pem', '.key', '.p12'];

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

export function buildStatic({ root = ROOT, out = OUT, log = console.log } = {}) {
  for (const entry of PUBLIC_ENTRIES) {
    if (!existsSync(join(root, entry))) throw new Error(`Entrée publique manquante : ${entry}`);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const entry of PUBLIC_ENTRIES) {
    cpSync(join(root, entry), join(out, entry), {
      recursive: true,
      preserveTimestamps: true,
      // Jamais de fichiers cachés (.DS_Store, .env…) dans la sortie publique.
      filter: (src) => !basename(src).startsWith('.'),
    });
  }

  const files = listFiles(out);
  const forbidden = files.filter((file) => FORBIDDEN_EXTENSIONS.some((ext) => file.endsWith(ext)));
  if (forbidden.length > 0) {
    throw new Error(`Fichiers interdits dans la sortie : ${forbidden.map((f) => relative(out, f)).join(', ')}`);
  }

  log(`build-static: ${files.length} fichiers copiés dans ${relative(root, out)}/`);
  return files.map((file) => relative(out, file));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildStatic();
}
