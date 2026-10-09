/**
 * Gestion des supports NFC par le propriétaire : appairage, activation,
 * désactivation, compromission, remplacement. Aucune clé ici : l'appairage
 * n'aboutit qu'à la première lecture SUN valide (voir tap.ts), ce qui prouve
 * que la puce a été programmée avec les clés Taply.
 */
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { NFC_PAIRING_TTL_MINUTES } from './tap.js';

export async function openPairing(
  client: PoolClient, principal: AuthenticatedPrincipal, input: { label: string; replacesTagId?: string },
): Promise<{ expiresAt: string } | 'not_found' | 'forbidden'> {
  if (principal.role !== 'owner') return 'forbidden';
  const program = await client.query<{ id: string }>(
    `select id from taply.loyalty_programs where merchant_id = $1 and status <> 'archived'
      order by created_at, id limit 1`,
    [principal.merchantId],
  );
  const programId = program.rows[0]?.id;
  if (programId === undefined) return 'not_found';
  if (input.replacesTagId !== undefined) {
    const old = await client.query('select 1 from taply.nfc_tags where id = $1 and merchant_id = $2',
      [input.replacesTagId, principal.merchantId]);
    if (old.rowCount !== 1) return 'not_found';
  }
  // Une seule fenêtre ouverte à la fois : les précédentes expirent.
  await client.query(
    `update taply.nfc_pairings set consumed_at = now()
      where merchant_id = $1 and consumed_at is null`,
    [principal.merchantId],
  );
  const inserted = await client.query<{ expires_at: Date | string }>(
    `insert into taply.nfc_pairings (merchant_id, program_id, label, replaces_tag_id, created_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) returning expires_at`,
    [principal.merchantId, programId, input.label, input.replacesTagId ?? null, principal.merchantUserId,
      NFC_PAIRING_TTL_MINUTES],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('nfc pairing insert failed');
  return { expiresAt: new Date(row.expires_at).toISOString() };
}

export async function cancelPairing(client: PoolClient, principal: AuthenticatedPrincipal): Promise<void> {
  await client.query(
    `update taply.nfc_pairings set consumed_at = now() where merchant_id = $1 and consumed_at is null`,
    [principal.merchantId],
  );
}

/**
 * Transitions autorisées : active ↔ disabled ; active/disabled → compromised
 * ou retired (définitif). Une puce compromise ne peut jamais être réactivée.
 */
export async function setTagStatus(
  client: PoolClient, principal: AuthenticatedPrincipal, tagId: string,
  status: 'active' | 'disabled' | 'compromised' | 'retired',
): Promise<'updated' | 'not_found' | 'forbidden' | 'invalid_transition'> {
  if (principal.role !== 'owner') return 'forbidden';
  const current = await client.query<{ status: string }>(
    'select status from taply.nfc_tags where id = $1 and merchant_id = $2 for update',
    [tagId, principal.merchantId],
  );
  const from = current.rows[0]?.status;
  if (from === undefined) return 'not_found';
  const allowed: Record<string, readonly string[]> = {
    active: ['disabled', 'compromised', 'retired'],
    disabled: ['active', 'compromised', 'retired'],
    compromised: [],
    retired: [],
  };
  if (!(allowed[from] ?? []).includes(status)) return 'invalid_transition';
  await client.query(
    'update taply.nfc_tags set status = $3, updated_at = now() where id = $1 and merchant_id = $2',
    [tagId, principal.merchantId, status],
  );
  if (status !== 'active') {
    // Plus aucune puce active : le passage automatique est coupé.
    await client.query(
      `update taply.program_preferences pref set nfc_auto_enabled = false, updated_at = now()
        where pref.merchant_id = $1 and not exists (
          select 1 from taply.nfc_tags t where t.merchant_id = $1 and t.program_id = pref.program_id
            and t.status = 'active')`,
      [principal.merchantId],
    );
  }
  return 'updated';
}
