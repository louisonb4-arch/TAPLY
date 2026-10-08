/**
 * Invariants statiques DDL — Phase 4 : membership_states, visit_ledger,
 * redemption_ledger (migration 20261008100001).
 *
 * Tests purement textuels sur le SQL brut. Aucune connexion DB, aucun
 * faux test dynamique. Les commentaires SQL sont retirés avant assertion.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const MIGRATION_FILE = join(MIGRATIONS_DIR, '20261008100001_loyalty_membership_state_and_ledger.sql');
const body = stripSqlComments(readFileSync(MIGRATION_FILE, 'utf8'));

// Toutes les migrations pour vérifier que les fichiers gelés ne sont pas touchés.
const allFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => join(MIGRATIONS_DIR, name));

// ── Invariant structurel : aucune migration gelée modifiée ──────────

describe('Phase 4 : préservation du périmètre des migrations historiques 0001–0013', () => {
  it('les treize fichiers historiques 0001–0013 sont toujours présents', () => {
    const certified = allFiles.filter((f) => /(^|\/)202610071200(0[1-9]|1[0-3])_/.test(f));
    expect(certified).toHaveLength(13);
  });

  it('aucun ALTER TABLE sur les tables gelées dans la migration Phase 4', () => {
    const frozenTables = [
      'merchants', 'locations', 'loyalty_programs', 'program_rule_versions',
      'customers', 'memberships', 'idempotency_requests', 'public_enrollment_links',
      'merchant_users', 'merchant_sessions',
    ];
    for (const table of frozenTables) {
      expect(body, `alter table taply.${table}`).not.toMatch(
        new RegExp(`alter\\s+table\\s+taply\\.${table}\\b`, 'i'),
      );
    }
  });
});

// ── membership_states ───────────────────────────────────────────────

describe('Phase 4 : membership_states', () => {
  it('table créée dans le schéma taply', () => {
    expect(body).toMatch(/create\s+table\s+taply\.membership_states\s*\(/i);
  });

  it('RLS enabled + forced', () => {
    expect(body).toMatch(/alter\s+table\s+taply\.membership_states\s+enable\s+row\s+level\s+security\s*;/i);
    expect(body).toMatch(/alter\s+table\s+taply\.membership_states\s+force\s+row\s+level\s+security\s*;/i);
  });

  it('ownership transféré à taply_owner', () => {
    expect(body).toMatch(/alter\s+table\s+taply\.membership_states\s+owner\s+to\s+taply_owner\s*;/i);
  });

  it('PK sur membership_id (1:1 avec memberships)', () => {
    expect(body).toMatch(/primary\s+key\s*\(\s*membership_id\s*\)/i);
  });

  it('FK composite (membership_id, merchant_id) → memberships(id, merchant_id)', () => {
    expect(body).toMatch(
      /foreign\s+key\s*\(\s*membership_id\s*,\s*merchant_id\s*\)\s*\n?\s*references\s+taply\.memberships\s*\(\s*id\s*,\s*merchant_id\s*\)/i,
    );
  });

  it('visit_count borné [0, 10] par CHECK', () => {
    expect(body).toMatch(/visit_count\s*>=\s*0\s+and\s+visit_count\s*<=\s*10/i);
  });

  it('cycle_number >= 1 par CHECK', () => {
    expect(body).toMatch(/membership_states_cycle_number_positive\s+check\s*\(\s*cycle_number\s*>=\s*1\s*\)/i);
  });

  it('GRANT SELECT + INSERT (pas DELETE)', () => {
    expect(body).toMatch(/grant\s+select\s+on\s+taply\.membership_states\s+to\s+taply_app\s*;/i);
    expect(body).toMatch(/grant\s+insert\s*\(\s*membership_id\s*,\s*merchant_id\s*\)\s+on\s+taply\.membership_states\s+to\s+taply_app\s*;/i);
    expect(body).not.toMatch(/grant\s+insert\s+on\s+taply\.membership_states/i);
    expect(body).not.toMatch(/grant\s+[^;]*\bdelete\b[^;]*on\s+taply\.membership_states/i);
  });

  it('UPDATE limité aux colonnes visit_count, reward_pending, last_credited_at, cycle_number, updated_at', () => {
    expect(body).toMatch(
      /grant\s+update\s*\(\s*visit_count\s*,\s*reward_pending\s*,\s*last_credited_at\s*,\s*cycle_number\s*,\s*updated_at\s*\)\s*\n?\s*on\s+taply\.membership_states\s+to\s+taply_app\s*;/i,
    );
  });

  it('aucun GRANT UPDATE table entière sur membership_states', () => {
    // UPDATE doit toujours être colonne par colonne.
    expect(body).not.toMatch(/grant\s+[^(;]*\bupdate\b\s+on\s+taply\.membership_states/i);
  });

  it('policies select_tenant, insert_tenant, update_tenant avec merchant_id GUC', () => {
    expect(body).toMatch(/create\s+policy\s+select_tenant\s+on\s+taply\.membership_states/i);
    expect(body).toMatch(/create\s+policy\s+insert_tenant\s+on\s+taply\.membership_states/i);
    expect(body).toMatch(/create\s+policy\s+update_tenant\s+on\s+taply\.membership_states/i);
  });
});

// ── visit_ledger ────────────────────────────────────────────────────

describe('Phase 4 : visit_ledger', () => {
  it('table créée dans le schéma taply', () => {
    expect(body).toMatch(/create\s+table\s+taply\.visit_ledger\s*\(/i);
  });

  it('RLS enabled + forced', () => {
    expect(body).toMatch(/alter\s+table\s+taply\.visit_ledger\s+enable\s+row\s+level\s+security\s*;/i);
    expect(body).toMatch(/alter\s+table\s+taply\.visit_ledger\s+force\s+row\s+level\s+security\s*;/i);
  });

  it('ownership transféré à taply_owner', () => {
    expect(body).toMatch(/alter\s+table\s+taply\.visit_ledger\s+owner\s+to\s+taply_owner\s*;/i);
  });

  it('FK composite (membership_id, merchant_id) → memberships(id, merchant_id)', () => {
    expect(body).toMatch(
      /visit_ledger_membership_merchant_fkey[\s\S]*?foreign\s+key\s*\(\s*membership_id\s*,\s*merchant_id\s*\)\s*\n?\s*references\s+taply\.memberships\s*\(\s*id\s*,\s*merchant_id\s*\)/i,
    );
  });

  it('source CHECK restreint à QR_EMPLOYEE et NFC — jamais QR_PUBLIC', () => {
    expect(body).toMatch(/source\s+in\s*\(\s*'QR_EMPLOYEE'\s*,\s*'NFC'\s*\)/i);
    expect(body).not.toMatch(/QR_PUBLIC/i);
  });

  it('clé idempotence UNIQUE (membership_id, idempotency_key)', () => {
    expect(body).toMatch(/visit_ledger_membership_idempotency_key\s+unique\s*\(\s*membership_id\s*,\s*idempotency_key\s*\)/i);
  });

  it('cycle_number >= 1 par CHECK', () => {
    expect(body).toMatch(/visit_ledger_cycle_number_positive\s+check\s*\(\s*cycle_number\s*>=\s*1\s*\)/i);
  });

  it('journal IMMUTABLE : SELECT + INSERT seulement, aucun UPDATE ni DELETE', () => {
    expect(body).toMatch(/grant\s+select\s+on\s+taply\.visit_ledger\s+to\s+taply_app\s*;/i);
    expect(body).toMatch(/grant\s+insert\s*\(\s*membership_id\s*,\s*merchant_id\s*,\s*cycle_number\s*,\s*source\s*,\s*idempotency_key\s*\)\s+on\s+taply\.visit_ledger\s+to\s+taply_app\s*;/i);
    expect(body).not.toMatch(/grant\s+insert\s+on\s+taply\.visit_ledger/i);
    expect(body).not.toMatch(/grant\s+[^;]*\bupdate\b[^;]*on\s+taply\.visit_ledger/i);
    expect(body).not.toMatch(/grant\s+[^;]*\bdelete\b[^;]*on\s+taply\.visit_ledger/i);
  });

  it('policies select_tenant + insert_tenant uniquement (pas update_tenant)', () => {
    expect(body).toMatch(/create\s+policy\s+select_tenant\s+on\s+taply\.visit_ledger/i);
    expect(body).toMatch(/create\s+policy\s+insert_tenant\s+on\s+taply\.visit_ledger/i);
    expect(body).not.toMatch(/create\s+policy\s+update_tenant\s+on\s+taply\.visit_ledger/i);
  });
});

// ── redemption_ledger ───────────────────────────────────────────────

describe('Phase 4 : redemption_ledger', () => {
  it('table créée dans le schéma taply', () => {
    expect(body).toMatch(/create\s+table\s+taply\.redemption_ledger\s*\(/i);
  });

  it('RLS enabled + forced', () => {
    expect(body).toMatch(/alter\s+table\s+taply\.redemption_ledger\s+enable\s+row\s+level\s+security\s*;/i);
    expect(body).toMatch(/alter\s+table\s+taply\.redemption_ledger\s+force\s+row\s+level\s+security\s*;/i);
  });

  it('ownership transféré à taply_owner', () => {
    expect(body).toMatch(/alter\s+table\s+taply\.redemption_ledger\s+owner\s+to\s+taply_owner\s*;/i);
  });

  it('FK composite (membership_id, merchant_id) → memberships(id, merchant_id)', () => {
    expect(body).toMatch(
      /redemption_ledger_membership_merchant_fkey[\s\S]*?foreign\s+key\s*\(\s*membership_id\s*,\s*merchant_id\s*\)\s*\n?\s*references\s+taply\.memberships\s*\(\s*id\s*,\s*merchant_id\s*\)/i,
    );
  });

  it('unicité (membership_id, cycle_number) empêche double remise', () => {
    expect(body).toMatch(/redemption_ledger_membership_cycle_key\s+unique\s*\(\s*membership_id\s*,\s*cycle_number\s*\)/i);
  });

  it('cycle_number >= 1 par CHECK', () => {
    expect(body).toMatch(/redemption_ledger_cycle_number_positive\s+check\s*\(\s*cycle_number\s*>=\s*1\s*\)/i);
  });

  it('journal IMMUTABLE : SELECT + INSERT seulement, aucun UPDATE ni DELETE', () => {
    expect(body).toMatch(/grant\s+select\s+on\s+taply\.redemption_ledger\s+to\s+taply_app\s*;/i);
    expect(body).toMatch(/grant\s+insert\s*\(\s*membership_id\s*,\s*merchant_id\s*,\s*cycle_number\s*\)\s+on\s+taply\.redemption_ledger\s+to\s+taply_app\s*;/i);
    expect(body).not.toMatch(/grant\s+insert\s+on\s+taply\.redemption_ledger/i);
    expect(body).not.toMatch(/grant\s+[^;]*\bupdate\b[^;]*on\s+taply\.redemption_ledger/i);
    expect(body).not.toMatch(/grant\s+[^;]*\bdelete\b[^;]*on\s+taply\.redemption_ledger/i);
  });

  it('policies select_tenant + insert_tenant uniquement', () => {
    expect(body).toMatch(/create\s+policy\s+select_tenant\s+on\s+taply\.redemption_ledger/i);
    expect(body).toMatch(/create\s+policy\s+insert_tenant\s+on\s+taply\.redemption_ledger/i);
    expect(body).not.toMatch(/create\s+policy\s+update_tenant\s+on\s+taply\.redemption_ledger/i);
  });
});

// ── Invariants transversaux Phase 4 ─────────────────────────────────

describe('Phase 4 : invariants transversaux', () => {
  it('aucun SECURITY DEFINER', () => {
    expect(body).not.toMatch(/security\s+definer/i);
  });

  it('aucun SET ROLE / RESET ROLE', () => {
    expect(body).not.toMatch(/\bset\s+role\b/i);
    expect(body).not.toMatch(/\breset\s+role\b/i);
  });

  it('aucun GRANT de rôle (pas de GRANT ... TO ...)', () => {
    // Seuls les GRANT sur tables sont attendus, jamais de GRANT role TO role.
    const grantToLines = body.match(/grant\s+\w+\s+to\s+\w+/gi) ?? [];
    // Filtrer les grants sur tables (grant ... on taply.xxx to taply_app).
    const roleGrants = grantToLines.filter((g) => !g.match(/on\s+taply\./i));
    expect(roleGrants, 'aucun grant de rôle attendu').toHaveLength(0);
  });

  it('aucun ON DELETE CASCADE', () => {
    expect(body).not.toMatch(/on\s+delete\s+cascade/i);
  });

  it('toutes les FK sont ON DELETE RESTRICT', () => {
    const fkBlocks = body.match(/foreign\s+key[\s\S]*?on\s+delete\s+\w+/gi) ?? [];
    expect(fkBlocks.length).toBeGreaterThanOrEqual(3);
    for (const fk of fkBlocks) {
      expect(fk).toMatch(/on\s+delete\s+restrict/i);
    }
  });

  it('credited_at et redeemed_at utilisent DEFAULT now() — timestamp serveur', () => {
    expect(body).toMatch(/credited_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
    expect(body).toMatch(/redeemed_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  });

  it('3 tables créées, 3 ownership transférés', () => {
    const creates = body.match(/create\s+table\s+taply\.\w+/gi) ?? [];
    const owners = body.match(/alter\s+table\s+taply\.\w+\s+owner\s+to\s+taply_owner/gi) ?? [];
    expect(creates).toHaveLength(3);
    expect(owners).toHaveLength(3);
  });

  it('la migration Phase 4 existe sans bloquer les migrations ultérieures', () => {
    expect(allFiles).toContain(MIGRATION_FILE);
  });
});
