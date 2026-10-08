/**
 * Invariants statiques de la migration QR Wallet.
 * Ces assertions ne remplacent jamais les tests PostgreSQL RLS réels.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../../../supabase/migrations/20261008100002_wallet_qr_tokens.sql', import.meta.url)), 'utf8')
  .split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');

describe('wallet_qr_tokens : isolation et privilèges', () => {
  it('nouvelle table séparée ; aucune modification de memberships', () => {
    expect(migration).toMatch(/create table taply\.wallet_qr_tokens/i);
    expect(migration).not.toMatch(/alter table taply\.memberships/i);
  });

  it('FK membership et marchand composite, suppressions restrict', () => {
    expect(migration).toMatch(/foreign key \(membership_id, merchant_id\)\s*references taply\.memberships \(id, merchant_id\)\s*on delete restrict/i);
  });

  it('un seul jeton actif par adhésion et hash global unique', () => {
    expect(migration).toMatch(/unique index wallet_qr_tokens_token_hash_key/i);
    expect(migration).toMatch(/unique index wallet_qr_tokens_one_active_per_membership[\s\S]*?where revoked_at is null/i);
    expect(migration).toMatch(/token_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'/i);
  });

  it('RLS activée et FORCE, rôles applicatifs stricts', () => {
    expect(migration).toMatch(/alter table taply\.wallet_qr_tokens enable row level security/i);
    expect(migration).toMatch(/alter table taply\.wallet_qr_tokens force row level security/i);
    expect(migration).toMatch(/owner to taply_owner/i);
    expect(migration).toMatch(/app\.merchant_id/);
    expect(migration).not.toMatch(/security definer/i);
  });

  it('INSERT uniquement sur colonnes nécessaires, jamais token brut', () => {
    expect(migration).toMatch(/grant insert \(membership_id, merchant_id, token_hash\)\s*on taply\.wallet_qr_tokens to taply_app/i);
    expect(migration).not.toMatch(/grant insert on taply\.wallet_qr_tokens/i);
    expect(migration).not.toMatch(/raw_token\s+text/i);
  });

  it('UPDATE réduit à révocation ; impossible de réactiver sous policy', () => {
    expect(migration).toMatch(/grant update \(revoked_at\)\s*on taply\.wallet_qr_tokens to taply_app/i);
    expect(migration).toMatch(/create policy revoke_tenant[\s\S]*?with check \([\s\S]*?revoked_at is not null/i);
    expect(migration).not.toMatch(/grant delete/i);
    expect(migration).not.toMatch(/grant update on taply\.wallet_qr_tokens/i);
  });

  it('n’autorise ni schéma public ni politique anon', () => {
    expect(migration).not.toMatch(/to anon\b|to authenticated\b|to public\b/i);
  });
});
