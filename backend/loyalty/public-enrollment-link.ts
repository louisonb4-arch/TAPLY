/**
 * Un seul lien QR public par commerce pour le pilote. Le jeton n'est PAS
 * un jeton client ; les passages ne peuvent toujours être validés que
 * par un appareil staff + PIN + présence + achat.
 *
 * Lecture/écriture via withAuthenticatedTx (même session, mêmes GUC)
 * et FORCE RLS PostgreSQL. Jamais de token via logs.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';

export interface PublicLink {
  publicToken: string;
  programId: string;
  locationId: string;
  created: boolean;
}

interface LinkRow {
  public_token: string;
  program_id: string;
  location_id: string;
}

export async function getMerchantPublicLink(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
): Promise<PublicLink | null> {
  if (principal.role !== 'owner') return null;
  const r = await client.query<LinkRow>(
    `select public_token, program_id, location_id
       from taply.public_enrollment_links
      where merchant_id=$1 and status='active'
      order by created_at, id limit 1`, [principal.merchantId],
  );
  const row = r.rows[0];
  return row
    ? { publicToken: row.public_token, programId: row.program_id, locationId: row.location_id, created: false }
    : null;
}

export async function ensureMerchantPublicLink(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
): Promise<PublicLink | null> {
  if (principal.role !== 'owner') return null;
  // Sérialiser les POST concurrents d'un même commerce, pas de doublons.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
    ['taply:pilot-public-link:' + principal.merchantId]);

  const existing = await getMerchantPublicLink(client, principal);
  if (existing) return existing;

  const business = await client.query<{ id: string }>(
    `select id from taply.merchants where id=$1 and status='active'`,
    [principal.merchantId],
  );
  if (!business.rows[0]) return null;
  const programs = await client.query<{ id: string }>(
    `select id from taply.loyalty_programs
       where merchant_id=$1 and status='active'
       order by created_at,id limit 1`, [principal.merchantId],
  );
  const program = programs.rows[0];
  if (!program) return null;

  const locations = await client.query<{ id: string }>(
    `select id from taply.locations
       where merchant_id=$1 and status='active'
       order by created_at,id limit 1`, [principal.merchantId],
  );
  let locationId = locations.rows[0]?.id;
  if (!locationId) {
    const created = await client.query<{ id: string }>(
      `insert into taply.locations(merchant_id,name,slug)
       values($1,'Établissement principal','principal') returning id`,
      [principal.merchantId],
    );
    locationId = created.rows[0]?.id;
  }
  if (!locationId) throw new Error('Failed to create merchant location');

  // 160 bits ; format base64url sûr dans le QR de comptoir.
  const publicToken = randomBytes(20).toString('base64url');
  await client.query(
    `insert into taply.public_enrollment_links
       (public_token,merchant_id,location_id,program_id)
       values($1,$2,$3,$4)`,
    [publicToken, principal.merchantId, locationId, program.id],
  );
  return { publicToken, programId: program.id, locationId, created: true };
}
