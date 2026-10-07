/**
 * Garde-fous structurels du dépôt (architecture V4).
 * Ces tests échouent si quelqu'un réintroduit un risque connu.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PUBLIC_ENTRIES, buildStatic } from '../../scripts/build-static.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Racine du dépôt : tout ce qui n'est PAS public doit être listé ici. */
const PRIVATE_ROOT_FILES = [
  '.gitignore',
  '.env.example',
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vercel.json',
  'vitest.config.ts',
];
const PRIVATE_ROOT_DIRS = ['api', 'backend', 'scripts', 'tests', 'supabase', 'docs'];
/** Générés ou locaux, jamais versionnés. */
const IGNORED_ROOT = [
  '.git',
  '.vercel',
  '.claude',
  '.mcp.json',
  '.DS_Store',
  'node_modules',
  'dist',
  'test-results',
  'playwright-report',
  'coverage',
];

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('invariants du dépôt', () => {
  it('aucun dossier public/ à la racine (Vercel servirait public/ à la place du site)', () => {
    expect(existsSync(join(ROOT, 'public'))).toBe(false);
  });

  it('vercel.json : aucun framework, sortie statique = dist/, routage explicite', () => {
    const config = JSON.parse(read('vercel.json')) as Record<string, unknown>;
    expect(config['framework']).toBeNull();
    expect(config['buildCommand']).toBe('node scripts/build-static.mjs');
    expect(config['outputDirectory']).toBe('dist');
    expect(config['rewrites']).toBeUndefined();
    expect(config['routes']).toEqual([
      { handle: 'filesystem' },
      { src: '^/api(?:/.*)?$', dest: '/api' },
      { src: '^/.*$', status: 404, dest: '/404.html' },
    ]);
  });

  it("aucun fichier d'entrée qui déclencherait la détection Hono « zéro-config » de Vercel", () => {
    const candidates = ['app', 'index', 'server', 'src/app', 'src/index', 'src/server'].flatMap((base) =>
      ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((ext) => `${base}.${ext}`),
    );
    for (const candidate of candidates) {
      expect(existsSync(join(ROOT, candidate)), candidate).toBe(false);
    }
  });

  it('une seule Vercel Function : api/index.ts', () => {
    const files = readdirSync(join(ROOT, 'api')).filter((f) => !f.startsWith('.'));
    expect(files).toEqual(['index.ts']);
  });

  it('package.json : ESM, sans framework front, sans script de build implicite, versions figées', () => {
    const pkg = JSON.parse(read('package.json')) as {
      type: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.type).toBe('module');
    // Le build Vercel est piloté uniquement par vercel.json (buildCommand).
    expect(pkg.scripts['build']).toBeUndefined();
    expect(pkg.scripts['vercel-build']).toBeUndefined();
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbidden of ['next', 'react', 'react-dom', 'vue', 'svelte', '@sveltejs/kit', 'nuxt', 'astro']) {
      expect(all[forbidden], forbidden).toBeUndefined();
    }
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('chaque entrée de la racine est classée : publique (liste blanche) ou privée', () => {
    const classified = new Set([...PUBLIC_ENTRIES, ...PRIVATE_ROOT_FILES, ...PRIVATE_ROOT_DIRS, ...IGNORED_ROOT]);
    const unclassified = readdirSync(ROOT).filter((name) => !classified.has(name));
    expect(unclassified, 'nouvelle entrée à la racine : à ajouter à PUBLIC_ENTRIES ou à la liste privée').toEqual([]);
    for (const entry of PUBLIC_ENTRIES) {
      expect(PRIVATE_ROOT_FILES.includes(entry) || PRIVATE_ROOT_DIRS.includes(entry), entry).toBe(false);
    }
  });

  it("aucun fichier d'environnement suivi par git", () => {
    const gitignore = read('.gitignore');
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^\.env\.\*$/m);
    expect(gitignore).toMatch(/^dist\/$/m);
  });

  it('.mcp.json (config MCP locale) jamais suivi par git', () => {
    expect(read('.gitignore')).toMatch(/^\.mcp\.json$/m);
  });
});

describe('build statique (dist/)', () => {
  const out = mkdtempSync(join(tmpdir(), 'taply-dist-'));
  const copied = buildStatic({ root: ROOT, out, log: () => {} });

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('copie tout le site public, octet pour octet, aux mêmes chemins', () => {
    const expected = PUBLIC_ENTRIES.flatMap((entry) => {
      const path = join(ROOT, entry);
      return statSync(path).isDirectory() ? listFiles(path).map((file) => relative(ROOT, file)) : [entry];
    }).sort();
    expect([...copied].sort()).toEqual(expected);
    for (const file of expected) {
      expect(sha256(join(out, file)), file).toBe(sha256(join(ROOT, file)));
    }
  });

  it("n'expose aucun fichier privé (code backend, tests, configuration)", () => {
    const leaked = copied.filter(
      (file) =>
        /\.(ts|mts|cts|map)$/.test(file) ||
        PRIVATE_ROOT_FILES.includes(file) ||
        PRIVATE_ROOT_DIRS.some((dir) => file.startsWith(`${dir}/`)),
    );
    expect(leaked).toEqual([]);
  });

  it('repart toujours d’un dist/ vide : aucun fichier obsolète ne survit', () => {
    const staleOut = mkdtempSync(join(tmpdir(), 'taply-dist-stale-'));
    try {
      buildStatic({ root: ROOT, out: staleOut, log: () => {} });
      // Fichiers parasites : à la racine, dans un dossier public, dans un dossier inconnu.
      const parasites = ['stale-asset.css', 'css/supprime-du-site.css', 'ancien-dossier/page.html'];
      for (const file of parasites) {
        mkdirSync(join(staleOut, file, '..'), { recursive: true });
        writeFileSync(join(staleOut, file), 'stale');
        expect(existsSync(join(staleOut, file)), file).toBe(true);
      }
      const rebuilt = buildStatic({ root: ROOT, out: staleOut, log: () => {} });
      for (const file of parasites) {
        expect(existsSync(join(staleOut, file)), file).toBe(false);
      }
      expect(existsSync(join(staleOut, 'ancien-dossier'))).toBe(false);
      expect(listFiles(staleOut).length).toBe(rebuilt.length);
    } finally {
      rmSync(staleOut, { recursive: true, force: true });
    }
  });

  it('contient les pages principales et la page 404', () => {
    for (const page of ['index.html', '404.html', 'connexion.html', 'dashboard/index.html', 'robots.txt']) {
      expect(copied, page).toContain(page);
    }
  });
});
