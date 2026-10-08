import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../../supabase/migrations/20261008100010_program_publications.sql', import.meta.url), 'utf8');

describe('QR V1 publication additive — SQL contract', () => {
  it('préserve un état non publié et exige une récompense avant publication', () => {
    expect(sql).toContain('published_at timestamptz');
    expect(sql).toMatch(/published_at is null or reward_title is not null/i);
    expect(sql).toMatch(/reward_title text/i);
    expect(sql).toMatch(/reward_title is null or length\(btrim\(reward_title\)\) between 3 and 120/i);
    expect(sql).not.toMatch(/\b(drop|truncate|delete from|update taply\.memberships)\b/i);
  });
  it('filtre toutes les opérations sous FORCE RLS merchant', () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/force row level security/i);
    for (const op of ['select', 'insert', 'update']) {
      expect(sql).toMatch(new RegExp('create policy program_publications_' + op + '_tenant', 'i'));
    }
    expect(sql.match(/current_setting\('app.merchant_id', true\)/g)?.length).toBe(4);
    expect(sql).not.toMatch(/to (?:public|anon|authenticated)\s*;/i);
  });
});
