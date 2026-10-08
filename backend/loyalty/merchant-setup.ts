/**
 * Merchant QR-V1 setup. Mutations exclusively on an authenticated owner
 * transaction with RLS tenant context. No account/customer secrets returned.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { isValidThreshold } from './rules.js';
import { merchantEnrollmentUrl } from './public-enrollment-token.js';

type SetupRow = {
  id: string; name: string; merchant_name: string; status: string;
  rule_id: string; version_no: number; threshold: number;
  reward_title: string | null; reward_terms: string | null;
  card_color: string | null; text_color: string | null; published_at: Date | null;
  public_token: string | null; public_link_status: string | null;
};

const SQL = `select p.id, p.name, m.name as merchant_name, p.status,
    v.id as rule_id, v.version_no, (v.rules->>'threshold')::integer as threshold,
    pub.reward_title,pub.reward_terms,pub.card_color,pub.text_color,pub.published_at,
    l.public_token,l.status as public_link_status
  from taply.loyalty_programs p
  join taply.merchants m on m.id=p.merchant_id
  join taply.program_rule_versions v on v.merchant_id=p.merchant_id
    and v.program_id=p.id and v.is_active=true
  left join taply.program_publications pub on pub.merchant_id=p.merchant_id
    and pub.program_id=p.id
  left join lateral (select public_token,status
      from taply.public_enrollment_links
      where merchant_id=p.merchant_id and program_id=p.id
      order by created_at,id limit 1) l on true
  where p.merchant_id=$1 and p.status<>'archived'
  order by p.created_at,p.id limit 1`;

async function lookup(client: PoolClient, principal: AuthenticatedPrincipal): Promise<SetupRow | undefined> {
  if (principal.role !== 'owner') return undefined;
  const data = await client.query<SetupRow>(SQL, [principal.merchantId]);
  return data.rows[0];
}

export async function readMerchantSetup(
  client: PoolClient, principal: AuthenticatedPrincipal, origin: string,
) {
  const row = await lookup(client, principal);
  if (!row) return undefined;
  const published = Boolean(row.published_at && row.public_link_status === 'active');
  return {
    programId: row.id, merchantName: row.merchant_name, name: row.name,
    threshold: row.threshold, rewardTitle: row.reward_title,
    rewardTerms: row.reward_terms ?? '',
    cardColor: row.card_color ?? '#10241A', textColor: row.text_color ?? '#FFFFFF',
    published, hasEnrollmentLink: Boolean(row.public_token),
    enrollmentUrl: published && row.public_token
      ? merchantEnrollmentUrl(origin, row.public_token) : null,
    // Preview intentionally cannot be used for membership creation.
    walletAvailable: false,
  };
}

export interface SetupInput {
  readonly threshold: number;
  readonly rewardTitle: string;
  readonly rewardTerms: string;
  readonly cardColor: string;
  readonly textColor: string;
}

export async function saveMerchantSetup(
  client: PoolClient, principal: AuthenticatedPrincipal, input: SetupInput,
): Promise<'updated' | 'not_found' | 'locked' | 'has_members'> {
  const row = await lookup(client, principal);
  if (!row) return 'not_found';
  if (row.published_at) return 'locked';
  if (!isValidThreshold(input.threshold)) return 'locked';
  // Lock program and query current rule AFTER lock, preventing concurrent writes.
  await client.query('select id from taply.loyalty_programs where id=$1 and merchant_id=$2 for update',
    [row.id, principal.merchantId]);
  const current = await lookup(client, principal);
  if (!current || current.published_at) return 'locked';
  if (current.threshold !== input.threshold) {
    const members = await client.query<{ total: number }>(
      'select count(*)::integer as total from taply.memberships where merchant_id=$1 and program_id=$2',
      [principal.merchantId, row.id]);
    if ((members.rows[0]?.total ?? 1) > 0) return 'has_members';
    const disabled = await client.query(
      'update taply.program_rule_versions set is_active=false where id=$1 and merchant_id=$2 and is_active=true',
      [current.rule_id, principal.merchantId]);
    if (disabled.rowCount !== 1) throw new Error('Rule version race');
    await client.query(
      `insert into taply.program_rule_versions
        (id,merchant_id,program_id,version_no,rules,is_active)
        values($1,$2,$3,$4,$5::jsonb,true)`,
      [randomUUID(), principal.merchantId, row.id, current.version_no + 1,
        JSON.stringify({ threshold: input.threshold })]);
  }
  const changed = await client.query(
    `insert into taply.program_publications
      (program_id,merchant_id,reward_title,reward_terms,card_color,text_color)
      values($1,$2,$3,$4,$5,$6)
      on conflict(program_id) do update set
        reward_title=excluded.reward_title,reward_terms=excluded.reward_terms,
        card_color=excluded.card_color,text_color=excluded.text_color,updated_at=now()
      where taply.program_publications.published_at is null`,
    [row.id, principal.merchantId, input.rewardTitle, input.rewardTerms,
      input.cardColor, input.textColor]);
  return changed.rowCount === 1 ? 'updated' : 'locked';
}

export async function publishMerchantSetup(
  client: PoolClient, principal: AuthenticatedPrincipal,
): Promise<'published' | 'not_found' | 'incomplete'> {
  const row = await lookup(client, principal);
  if (!row) return 'not_found';
  // Lock before repeatable checks to serialize setup edits and publication.
  await client.query('select id from taply.loyalty_programs where id=$1 and merchant_id=$2 for update',
    [row.id, principal.merchantId]);
  const current = await lookup(client, principal);
  if (!current || current.status !== 'active' || !isValidThreshold(current.threshold)
      || !current.reward_title?.trim() || !current.public_token) return 'incomplete';
  // A program is considered published only if BOTH publication and public
  // link are updated in the same transaction.
  if (!current.published_at) {
    await client.query(
      `update taply.program_publications set published_at=now(),updated_at=now()
       where program_id=$1 and merchant_id=$2 and published_at is null and reward_title is not null`,
      [current.id, principal.merchantId]);
  }
  const updated = await client.query(
    `update taply.public_enrollment_links set status='active',updated_at=now()
       where merchant_id=$1 and program_id=$2 and public_token=$3`,
    [principal.merchantId, current.id, current.public_token]);
  if (updated.rowCount !== 1) throw new Error('Public link publication mismatch');
  return 'published';
}
