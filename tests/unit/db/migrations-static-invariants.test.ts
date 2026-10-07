/**
 * Garde-fous statiques sur supabase/migrations/**.
 *
 * Hardening ownership (post-review) : plus de SET ROLE / RESET ROLE, plus
 * de dépendance à CURRENT_USER — ownership transféré explicitement via
 * ALTER TABLE ... OWNER TO taply_owner, après création sous le rôle de
 * migration (postgres).
 *
 * Les commentaires SQL (`-- …`) sont retirés avant tout test : on vérifie
 * le SQL réellement exécuté, pas la documentation qui en parle.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const FORBIDDEN_MEMBERS_OF_TAPLY_APP = [
  'anon',
  'authenticated',
  'service_role',
  'postgres',
  'authenticator',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_realtime_admin',
];

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => join(MIGRATIONS_DIR, name));
}

const files = migrationFiles();
const bodies = new Map(files.map((file) => [file, stripSqlComments(readFileSync(file, 'utf8'))]));

describe('supabase/migrations : invariants statiques d’ownership', () => {
  it('aucun fichier ne contient SET ROLE', () => {
    for (const [file, body] of bodies) {
      expect(body, file).not.toMatch(/\bset\s+role\b/i);
    }
  });

  it('aucun fichier ne contient RESET ROLE', () => {
    for (const [file, body] of bodies) {
      expect(body, file).not.toMatch(/\breset\s+role\b/i);
    }
  });

  it('aucun GRANT taply_owner TO CURRENT_USER', () => {
    for (const [file, body] of bodies) {
      expect(body, file).not.toMatch(/grant\s+taply_owner\s+to\s+current_user/i);
    }
  });

  it('exactement un GRANT taply_owner TO postgres, dans tout le dossier', () => {
    const all = [...bodies.values()].join('\n');
    const matches = all.match(/grant\s+taply_owner\s+to\s+postgres\s*;/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('aucun rôle interne Supabase/Postgres accordé en appartenance à taply_app', () => {
    for (const [file, body] of bodies) {
      for (const role of FORBIDDEN_MEMBERS_OF_TAPLY_APP) {
        const pattern = new RegExp(`grant\\s+${role}\\s+to\\s+taply_app`, 'i');
        expect(body, `${file} — grant ${role} to taply_app`).not.toMatch(pattern);
      }
    }
  });

  it('toute table taply.* créée transfère explicitement son ownership à taply_owner', () => {
    for (const [file, body] of bodies) {
      if (/create\s+table\s+taply\./i.test(body)) {
        expect(body, file).toMatch(/alter\s+table\s+taply\.\w+\s+owner\s+to\s+taply_owner\s*;/i);
      }
    }
  });

  it('le schéma taply est créé avec AUTHORIZATION taply_owner', () => {
    const all = [...bodies.values()].join('\n');
    expect(all).toMatch(/create\s+schema\s+if\s+not\s+exists\s+taply\s+authorization\s+taply_owner\s*;/i);
  });
});

describe('supabase/migrations : pre-staging patch (lookup, idempotency, role determinism)', () => {
  const all = [...bodies.values()].join('\n');

  it('taply_owner et taply_app réaffirment explicitement leurs attributs, NOREPLICATION inclus', () => {
    expect(all).toMatch(
      /alter\s+role\s+taply_owner\s+with\s+nologin\s+nosuperuser\s+nocreatedb\s+nocreaterole\s+nobypassrls\s+noreplication\s*;/i,
    );
    expect(all).toMatch(
      /alter\s+role\s+taply_app\s+with\s+login\s+nosuperuser\s+nocreatedb\s+nocreaterole\s+nobypassrls\s+noreplication\s*;/i,
    );
  });

  it('idempotency_requests : UPDATE limité aux colonnes status, response, updated_at (jamais la table entière)', () => {
    expect(all).toMatch(/grant\s+update\s*\(\s*status\s*,\s*response\s*,\s*updated_at\s*\)\s+on\s+taply\.idempotency_requests\s+to\s+taply_app\s*;/i);
    // Jamais un GRANT UPDATE sans liste de colonnes sur cette table.
    expect(all).not.toMatch(/grant\s+(?:select\s*,\s*)?insert\s*,\s*update\s+on\s+taply\.idempotency_requests/i);
  });

  it('public_enrollment_links : aucune policy select_tenant, seule public_token_lookup existe', () => {
    const file = files.find((f) => f.endsWith('public_enrollment_links.sql'));
    expect(file).toBeDefined();
    const body = bodies.get(file as string) ?? '';
    expect(body).not.toMatch(/create\s+policy\s+select_tenant\s+on\s+taply\.public_enrollment_links/i);
    expect(body).toMatch(/create\s+policy\s+public_token_lookup\s+on\s+taply\.public_enrollment_links/i);
  });

  it('backend/db/lookup.ts filtre explicitement WHERE public_token = $1, en plus de RLS', () => {
    const lookupSource = readFileSync(
      fileURLToPath(new URL('../../../backend/db/lookup.ts', import.meta.url)),
      'utf8',
    );
    expect(lookupSource).toMatch(/where\s+public_token\s*=\s*\$1/i);
  });

  it('backend/db/pool.ts : ssl explicite (ca + rejectUnauthorized: true), jamais rejectUnauthorized: false', () => {
    const poolSource = readFileSync(fileURLToPath(new URL('../../../backend/db/pool.ts', import.meta.url)), 'utf8');
    expect(poolSource).toMatch(/ca\s*:\s*db\.caCert/);
    expect(poolSource).toMatch(/rejectUnauthorized\s*:\s*true/);
    expect(poolSource).not.toMatch(/rejectUnauthorized\s*:\s*false/);
  });

  it('backend/core/config.ts : interdit sslmode/sslcert/sslkey/sslrootcert dans DATABASE_URL_APP', () => {
    const configSource = readFileSync(fileURLToPath(new URL('../../../backend/core/config.ts', import.meta.url)), 'utf8');
    for (const param of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      expect(configSource).toMatch(new RegExp(param));
    }
    expect(configSource).toMatch(/DATABASE_CA_CERT/);
  });

  it('.env.example : aucune valeur réelle pour DATABASE_CA_CERT, placeholder descriptif seulement', () => {
    const envExample = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    expect(envExample).toMatch(/^DATABASE_CA_CERT=$/m);
    expect(envExample).not.toMatch(/BEGIN CERTIFICATE-----\s*\n[A-Za-z0-9+/=]/);
  });
});
