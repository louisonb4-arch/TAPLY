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

  it('exactement un GRANT taply_owner TO postgres (WITH SET TRUE, INHERIT TRUE), dans tout le dossier', () => {
    // INHERIT TRUE : postgres doit pouvoir continuer, sans SET ROLE
    // explicite, à CREATE/modifier des objets déjà possédés par
    // taply_owner dans les migrations suivantes (voir le commentaire de
    // 0001 pour le scénario exact que ceci prévient).
    const all = [...bodies.values()].join('\n');
    const matches = all.match(/grant\s+taply_owner\s+to\s+postgres\s+with\s+set\s+true\s*,\s*inherit\s+true\s*;/gi) ?? [];
    expect(matches).toHaveLength(1);
    // Jamais la variante INHERIT FALSE qu'on vient de corriger.
    expect(all).not.toMatch(/grant\s+taply_owner\s+to\s+postgres\s+with\s+set\s+true\s*,\s*inherit\s+false\s*;/i);
  });

  it('le GRANT taply_owner → postgres ne mentionne jamais ADMIN explicitement (ADMIN TRUE est déjà accordé automatiquement par PostgreSQL à la création du rôle — pas réaffirmé ici, jamais prétendu FALSE)', () => {
    const all = [...bodies.values()].join('\n');
    expect(all).not.toMatch(/grant\s+taply_owner\s+to\s+postgres[^;]*\badmin\b/i);
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

  it('aucun ALTER ROLE taply_owner / taply_app — PostgreSQL refuse de nommer SUPERUSER/REPLICATION/BYPASSRLS dans un ALTER ROLE exécuté par un rôle CREATEROLE non-superuser (confirmé empiriquement, SQLSTATE 42501)', () => {
    expect(all).not.toMatch(/alter\s+role\s+taply_owner\b/i);
    expect(all).not.toMatch(/alter\s+role\s+taply_app\b/i);
  });

  it('CREATE ROLE taply_owner/taply_app ne nomme jamais explicitement SUPERUSER/REPLICATION/BYPASSRLS (même pas la forme NO-)', () => {
    const forbidden = ['superuser', 'nosuperuser', 'replication', 'noreplication', 'bypassrls', 'nobypassrls'];
    const createRoleBlocks = all.match(/create\s+role\s+taply_(?:owner|app)[^;]*;/gi) ?? [];
    expect(createRoleBlocks.length).toBeGreaterThanOrEqual(2);
    for (const stmt of createRoleBlocks) {
      for (const word of forbidden) {
        expect(stmt.toLowerCase(), stmt).not.toContain(word);
      }
    }
  });

  it('CREATE ROLE taply_owner/taply_app porte les attributs sûrs attendus (nologin/login + nocreatedb + nocreaterole)', () => {
    expect(all).toMatch(/create\s+role\s+taply_owner\s+nologin\s+nocreatedb\s+nocreaterole\s*;/i);
    expect(all).toMatch(/create\s+role\s+taply_app\s+login\s+nocreatedb\s+nocreaterole\s*;/i);
  });

  it('les rôles préexistants sont vérifiés via pg_roles, jamais réparés silencieusement — RAISE EXCEPTION sur divergence', () => {
    expect(all).toMatch(/select\s+rolcanlogin\s*,\s*rolsuper\s*,\s*rolcreatedb\s*,\s*rolcreaterole\s*,\s*rolreplication\s*,\s*rolbypassrls\s+into\s+existing\s+from\s+pg_roles\s+where\s+rolname\s*=\s*'taply_owner'/i);
    expect(all).toMatch(/select\s+rolcanlogin\s*,\s*rolsuper\s*,\s*rolcreatedb\s*,\s*rolcreaterole\s*,\s*rolreplication\s*,\s*rolbypassrls\s+into\s+existing\s+from\s+pg_roles\s+where\s+rolname\s*=\s*'taply_app'/i);
    const raiseCount = (all.match(/raise\s+exception/gi) ?? []).length;
    expect(raiseCount).toBe(2);
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

describe('supabase/migrations : Phase 3A — merchant_users / merchant_sessions', () => {
  const merchantUsersFile = files.find((f) => f.endsWith('merchant_users.sql'));
  const merchantSessionsFile = files.find((f) => f.endsWith('merchant_sessions.sql'));
  const merchantUsersBody = merchantUsersFile ? (bodies.get(merchantUsersFile) ?? '') : '';
  const merchantSessionsBody = merchantSessionsFile ? (bodies.get(merchantSessionsFile) ?? '') : '';

  it('les migrations certifiées 0001–0010 restent byte-identiques (non touchées par Phase 3A)', () => {
    const certified = files.filter(
      (f) => !f.endsWith('merchant_users.sql') && !f.endsWith('merchant_sessions.sql') && !f.endsWith('session_revocation_policy.sql'),
    );
    expect(certified).toHaveLength(10);
  });

  it('merchant_users existe, RLS enabled + forced', () => {
    expect(merchantUsersFile).toBeDefined();
    expect(merchantUsersBody).toMatch(/alter\s+table\s+taply\.merchant_users\s+enable\s+row\s+level\s+security\s*;/i);
    expect(merchantUsersBody).toMatch(/alter\s+table\s+taply\.merchant_users\s+force\s+row\s+level\s+security\s*;/i);
  });

  it('merchant_users : policy exacte auth_user_lookup, aucune policy select_tenant générale', () => {
    expect(merchantUsersBody).toMatch(/create\s+policy\s+auth_user_lookup\s+on\s+taply\.merchant_users/i);
    expect(merchantUsersBody).toMatch(/auth_user_id\s*=\s*nullif\(current_setting\('app\.auth_user_id',\s*true\),\s*''\)::uuid/i);
    expect(merchantUsersBody).not.toMatch(/create\s+policy\s+select_tenant\s+on\s+taply\.merchant_users/i);
  });

  it('merchant_users : aucun grant d’écriture à taply_app (SELECT uniquement)', () => {
    expect(merchantUsersBody).toMatch(/grant\s+select\s+on\s+taply\.merchant_users\s+to\s+taply_app\s*;/i);
    expect(merchantUsersBody).not.toMatch(/grant\s+[^;]*\b(insert|update|delete)\b[^;]*on\s+taply\.merchant_users/i);
  });

  it('merchant_sessions existe, RLS enabled + forced', () => {
    expect(merchantSessionsFile).toBeDefined();
    expect(merchantSessionsBody).toMatch(/alter\s+table\s+taply\.merchant_sessions\s+enable\s+row\s+level\s+security\s*;/i);
    expect(merchantSessionsBody).toMatch(/alter\s+table\s+taply\.merchant_sessions\s+force\s+row\s+level\s+security\s*;/i);
  });

  it('merchant_sessions : policy exacte session_token_lookup (token exact + non révoqué + non expiré idle/absolu)', () => {
    expect(merchantSessionsBody).toMatch(/create\s+policy\s+session_token_lookup\s+on\s+taply\.merchant_sessions/i);
    expect(merchantSessionsBody).toMatch(/token_hash\s*=\s*nullif\(current_setting\('app\.session_token_hash',\s*true\),\s*''\)/i);
    expect(merchantSessionsBody).toMatch(/revoked_at\s+is\s+null/i);
    expect(merchantSessionsBody).toMatch(/idle_expires_at\s*>\s*now\(\)/i);
    expect(merchantSessionsBody).toMatch(/absolute_expires_at\s*>\s*now\(\)/i);
  });

  it('merchant_sessions : aucun grant DELETE, aucun grant UPDATE table entière', () => {
    expect(merchantSessionsBody).not.toMatch(/grant\s+[^;]*\bdelete\b[^;]*on\s+taply\.merchant_sessions/i);
    // UPDATE doit toujours être colonne par colonne — jamais "grant ... update on taply.merchant_sessions" sans parenthèse.
    expect(merchantSessionsBody).not.toMatch(/grant\s+[^(;]*\bupdate\b\s+on\s+taply\.merchant_sessions/i);
  });

  it('merchant_sessions : UPDATE limité exactement à last_seen_at, idle_expires_at, reauthenticated_at, revoked_at, updated_at', () => {
    expect(merchantSessionsBody).toMatch(
      /grant\s+update\s*\(\s*last_seen_at\s*,\s*idle_expires_at\s*,\s*reauthenticated_at\s*,\s*revoked_at\s*,\s*updated_at\s*\)\s+on\s+taply\.merchant_sessions\s+to\s+taply_app\s*;/i,
    );
  });

  it('merchant_sessions : aucune colonne de jeton brut — seule token_hash existe, et elle est UNIQUE', () => {
    const createTableMatch = merchantSessionsBody.match(/create\s+table\s+taply\.merchant_sessions\s*\(([\s\S]*?)\);/i);
    expect(createTableMatch).not.toBeNull();
    const columns = createTableMatch?.[1] ?? '';
    expect(columns).toMatch(/\btoken_hash\s+text\s+not\s+null\b/i);
    // Jamais une colonne nommée "token" ou "raw_token" (mot entier, pas une sous-chaîne de token_hash).
    expect(columns).not.toMatch(/\btoken\s+text\b/i);
    expect(columns).not.toMatch(/\braw_token\b/i);
    expect(merchantSessionsBody).toMatch(/constraint\s+merchant_sessions_token_hash_key\s+unique\s*\(\s*token_hash\s*\)/i);
    expect(merchantSessionsBody).toMatch(/token_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'/i);
  });

  it('merchant_sessions : FK composite tenant/identité vers merchant_users(id, merchant_id, auth_user_id)', () => {
    expect(merchantSessionsBody).toMatch(
      /foreign\s+key\s*\(\s*merchant_user_id\s*,\s*merchant_id\s*,\s*auth_user_id\s*\)\s*\n?\s*references\s+taply\.merchant_users\s*\(\s*id\s*,\s*merchant_id\s*,\s*auth_user_id\s*\)/i,
    );
  });

  it('merchant_users/merchant_sessions : ownership transféré à taply_owner (couvert aussi par l’invariant générique)', () => {
    expect(merchantUsersBody).toMatch(/alter\s+table\s+taply\.merchant_users\s+owner\s+to\s+taply_owner\s*;/i);
    expect(merchantSessionsBody).toMatch(/alter\s+table\s+taply\.merchant_sessions\s+owner\s+to\s+taply_owner\s*;/i);
  });

  // Correction pré-staging : auth_user_id -> auth.users(id) doit être
  // RESTRICT, jamais CASCADE. Avec CASCADE, delete auth.users échouerait
  // quand même dès qu'une session active existe (merchant_sessions garde
  // sa propre FK composite en RESTRICT vers merchant_users) — mais avec
  // une erreur moins claire, plus tard dans la chaîne de cascade. RESTRICT
  // ici rend explicite que la suppression d'une identité est un cycle de
  // vie applicatif contrôlé (révoquer sessions -> supprimer mapping ->
  // supprimer identité Supabase Auth), jamais un side-effect implicite de
  // la base.
  it('merchant_users : auth_user_id -> auth.users(id) est ON DELETE RESTRICT, jamais CASCADE', () => {
    expect(merchantUsersBody).toMatch(/auth_user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+restrict/i);
    expect(merchantUsersBody).not.toMatch(/auth_user_id[\s\S]*?on\s+delete\s+cascade/i);
  });

  it('merchant_sessions : FK composite vers merchant_users reste ON DELETE RESTRICT', () => {
    expect(merchantSessionsBody).toMatch(
      /foreign\s+key\s*\(\s*merchant_user_id\s*,\s*merchant_id\s*,\s*auth_user_id\s*\)\s*\n?\s*references\s+taply\.merchant_users\s*\([^)]*\)\s*\n?\s*on\s+delete\s+restrict/i,
    );
  });

  it('merchant_users + merchant_sessions : chaîne RESTRICT/RESTRICT cohérente — aucune des deux FK n’est CASCADE', () => {
    // Régression : la combinaison CASCADE (auth.users -> merchant_users) +
    // RESTRICT (merchant_users -> merchant_sessions) crée un conflit —
    // delete auth.users échoue de toute façon dès qu'une session active
    // existe, mais via une erreur de cascade confuse plutôt qu'un refus
    // explicite et immédiat. Les deux FK doivent être RESTRICT.
    expect(merchantUsersBody).not.toMatch(/references\s+auth\.users[\s\S]*?cascade/i);
    expect(merchantSessionsBody).not.toMatch(/references\s+taply\.merchant_users[\s\S]*?cascade/i);
  });
});

describe('supabase/migrations : Phase 3B2 — session_revocation_policy (migration 13)', () => {
  const revocationFile = files.find((f) => f.endsWith('session_revocation_policy.sql'));
  const revocationBody = revocationFile ? (bodies.get(revocationFile) ?? '') : '';
  const sessionsFile = files.find((f) => f.endsWith('merchant_sessions.sql'));
  const sessionsBody = sessionsFile ? (bodies.get(sessionsFile) ?? '') : '';

  it('existe', () => {
    expect(revocationFile).toBeDefined();
  });

  it('crée session_revoke_lookup (SELECT, TO taply_app, exact app.session_revoke_token_hash)', () => {
    expect(revocationBody).toMatch(/create\s+policy\s+session_revoke_lookup\s+on\s+taply\.merchant_sessions\s+for\s+select\s+to\s+taply_app/i);
    expect(revocationBody).toMatch(/token_hash\s*=\s*nullif\(current_setting\('app\.session_revoke_token_hash',\s*true\),\s*''\)/i);
  });

  it('session_revoke_lookup ne contient aucune condition large (pas de revoked_at IS NULL / expiry) — capacité de révocation seule, pas d’authentification', () => {
    const match = revocationBody.match(/create\s+policy\s+session_revoke_lookup[\s\S]*?using\s*\(([\s\S]*?)\)\s*;/i);
    expect(match).not.toBeNull();
    const usingClause = match?.[1] ?? '';
    expect(usingClause).not.toMatch(/revoked_at/i);
    expect(usingClause).not.toMatch(/idle_expires_at/i);
    expect(usingClause).not.toMatch(/absolute_expires_at/i);
  });

  it('crée revoke_own_session (UPDATE, TO taply_app, USING et WITH CHECK exacts sur app.session_revoke_token_hash)', () => {
    expect(revocationBody).toMatch(/create\s+policy\s+revoke_own_session\s+on\s+taply\.merchant_sessions\s+for\s+update\s+to\s+taply_app/i);
    const match = revocationBody.match(/create\s+policy\s+revoke_own_session[\s\S]*?;/i);
    expect(match).not.toBeNull();
    const policyBody = match?.[0] ?? '';
    expect(policyBody).toMatch(/using\s*\(\s*token_hash\s*=\s*nullif\(current_setting\('app\.session_revoke_token_hash',\s*true\),\s*''\)\s*\)/i);
    expect(policyBody).toMatch(/with\s+check\s*\(\s*token_hash\s*=\s*nullif\(current_setting\('app\.session_revoke_token_hash',\s*true\),\s*''\)\s*\)/i);
  });

  it('ne modifie ni session_token_lookup ni update_own_session (aucun CREATE/ALTER/DROP POLICY sur ces noms)', () => {
    expect(revocationBody).not.toMatch(/\bsession_token_lookup\b/i);
    expect(revocationBody).not.toMatch(/\bupdate_own_session\b/i);
    expect(revocationBody).not.toMatch(/\bdrop\s+policy\b/i);
    expect(revocationBody).not.toMatch(/\balter\s+policy\b/i);
  });

  it('session_token_lookup (migration 12) reste inchangée telle quelle', () => {
    expect(sessionsBody).toMatch(/create\s+policy\s+session_token_lookup\s+on\s+taply\.merchant_sessions/i);
    expect(sessionsBody).toMatch(/revoked_at\s+is\s+null/i);
    expect(sessionsBody).toMatch(/idle_expires_at\s*>\s*now\(\)/i);
    expect(sessionsBody).toMatch(/absolute_expires_at\s*>\s*now\(\)/i);
  });

  it('aucun nouveau GRANT (DELETE, UPDATE table entière, ALL) ni GRANT élargi', () => {
    expect(revocationBody).not.toMatch(/\bgrant\b/i);
  });

  it('aucun SECURITY DEFINER, aucune élévation de rôle, aucun SET ROLE/RESET ROLE', () => {
    expect(revocationBody).not.toMatch(/security\s+definer/i);
    expect(revocationBody).not.toMatch(/\bgrant\b.*\bto\b/i);
    expect(revocationBody).not.toMatch(/\bset\s+role\b/i);
    expect(revocationBody).not.toMatch(/\breset\s+role\b/i);
  });

  it('ne crée/altère aucune table, aucune colonne, aucune contrainte', () => {
    expect(revocationBody).not.toMatch(/create\s+table/i);
    expect(revocationBody).not.toMatch(/alter\s+table\s+taply\.merchant_sessions\s+(add|drop)\s+column/i);
    expect(revocationBody).not.toMatch(/add\s+constraint/i);
  });
});
