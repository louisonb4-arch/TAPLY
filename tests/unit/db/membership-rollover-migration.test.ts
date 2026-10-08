import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(fileURLToPath(new URL('../../../supabase/migrations/20261008100003_membership_rule_rollover.sql', import.meta.url)), 'utf8')
  .split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');

describe('permissions minimales sur rollover de cycle', () => {
  it('UPDATE strictement limité à la version épinglée et updated_at', () => {
    expect(migration).toMatch(/grant update \(current_rule_version_id, updated_at\)\s+on taply\.memberships to taply_app/i);
    expect(migration).not.toMatch(/grant update on taply\.memberships/i);
  });
  it('tenant policy UPDATE exige même marchand avant ET après', () => {
    expect(migration).toMatch(/create policy update_tenant on taply\.memberships/i);
    expect(migration).toMatch(/using \(merchant_id = nullif\(current_setting\('app\.merchant_id', true\), ''\)::uuid\)/i);
    expect(migration).toMatch(/with check \(merchant_id = nullif\(current_setting\('app\.merchant_id', true\), ''\)::uuid\)/i);
  });
  it('aucun DELETE, SECURITY DEFINER ni suppression de table', () => {
    expect(migration).not.toMatch(/grant delete|security definer|drop table|alter table/i);
  });
});
