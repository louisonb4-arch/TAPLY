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
 * Les ressources existantes sont copiées à l’octet. Le seul ajout compilé
 * est l’îlot React dashboard (bundle JS + utilitaires CSS Tailwind).
 * Les Vercel Functions (api/) sont construites séparément par Vercel.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

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

  // Îlot React isolé de la vitrine. Aucun TS/TSX ou source map public.
  // Les tests de whitelist construisent parfois une racine temporaire.
  if (resolve(root) === resolve(ROOT)) {
    buildSync({
      entryPoints: [join(root, 'components', 'dashboard-scroll.tsx')],
      outfile: join(out, 'js', 'dashboard-scroll-react.js'),
      bundle: true, minify: true, platform: 'browser', target: 'es2020',
      format: 'iife', sourcemap: false, legalComments: 'none',
    });
    execFileSync(join(root, 'node_modules', '.bin', 'tailwindcss'), [
      '-i', join(root, 'styles', 'dashboard-scroll.tailwind.css'),
      '-o', join(out, 'css', 'dashboard-scroll.css'), '--minify',
    ], { cwd: root, stdio: 'pipe' });
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
