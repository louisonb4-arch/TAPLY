/**
 * Anonymous consumer membership: no PII, no credit on public QR scan.
 * All operations occur inside withTenantTx after validating a published
 * merchant lookup token. Raw auth tokens never go into the database.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { generateWalletQrToken, hashWalletQrToken } from './qr-token.js';

const ANON_DOMAIN = 'taply:anonymous-session:v1:';
const RECOVERY_DOMAIN = 'taply:recovery:v1:';
const SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ENROLLS_10MIN = 100;

export function newAnonymousSession(): string {
  return randomBytes(32).toString('base64url');
}
export function hashAnonymousSession(token: string): string {
  return createHash('sha256').update(ANON_DOMAIN + token).digest('hex');
}
export function newRecoveryCode(): string {
  const bytes = randomBytes(20);
  return Array.from(bytes, b => SECRET_ALPHABET[b & 31]).join('');
}
export function recoveryHash(raw: string): string {
  return createHash('sha256').update(RECOVERY_DOMAIN + raw).digest('hex');
}
export function normaliseRecovery(raw: string): string | undefined {
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/.test(code) ? code : undefined;
}
export function clientSessionCookieName(programId: string): string {
  // Server-verified program UUID; cookies are independent per commerce.
  if (!/^[a-f0-9-]{36}$/i.test(programId)) throw new Error('Invalid program id');
  return 'taply_card_' + programId.replaceAll('-', '').toLowerCase();
}

interface PublicCardRow {
  id: string;
  merchant_name: string;
  threshold: number;
  reward_title: string;
  reward_terms: string;
}

export async function publicProgram(
  db: PoolClient, merchantId: string, programId: string,
): Promise<{ merchantName: string; threshold: number; rewardTitle: string; rewardTerms: string } | undefined> {
  const data = await db.query<PublicCardRow>(`
    select p.id,mer.name as merchant_name,(v.rules->>'threshold')::integer as threshold,
      pub.reward_title,pub.reward_terms
    from taply.loyalty_programs p
    join taply.merchants mer on mer.id=p.merchant_id
    join taply.program_publications pub on pub.program_id=p.id
      and pub.merchant_id=p.merchant_id and pub.published_at is not null
    join taply.program_rule_versions v on v.program_id=p.id
      and v.merchant_id=p.merchant_id and v.is_active=true
    where p.id=$1 and p.merchant_id=$2 and p.status='active'
      and mer.status='active'`, [programId, merchantId]);
  const row = data.rows[0];
  if (!row || row.threshold < 5 || row.threshold > 10) return undefined;
  return { merchantName: row.merchant_name, threshold: row.threshold,
    rewardTitle: row.reward_title, rewardTerms: row.reward_terms };
}

export async function existingAnonymousCard(
  db: PoolClient, merchantId: string, programId: string, rawSession: string | undefined,
) {
  if (!rawSession || !/^[A-Za-z0-9_-]{43}$/.test(rawSession)) return undefined;
  const data = await db.query<{
    membership_id: string; visit_count: number; reward_pending: boolean;
    cycle_number: number; threshold: number;
  }>(`select s.membership_id,ms.visit_count,ms.reward_pending,ms.cycle_number,
      (v.rules->>'threshold')::integer as threshold
    from taply.anonymous_card_sessions s
    join taply.memberships m on m.id=s.membership_id and m.merchant_id=s.merchant_id
    join taply.membership_states ms on ms.membership_id=m.id and ms.merchant_id=m.merchant_id
    join taply.program_rule_versions v on v.id=m.current_rule_version_id
      and v.merchant_id=m.merchant_id and v.program_id=m.program_id
    where s.merchant_id=$1 and s.program_id=$2 and s.token_hash=$3
      and s.revoked_at is null and s.expires_at>now() and m.status='active'`,
    [merchantId, programId, hashAnonymousSession(rawSession)]);
  const row = data.rows[0];
  if (!row) return undefined;
  return { membershipId: row.membership_id, visits: row.visit_count,
    rewardPending: row.reward_pending, cycleNumber: row.cycle_number,
    threshold: row.threshold };
}

async function issueSession(
  db: PoolClient, merchantId: string, programId: string, membershipId: string,
): Promise<string> {
  const secret = newAnonymousSession();
  const written = await db.query(
    `insert into taply.anonymous_card_sessions
      (merchant_id,program_id,membership_id,token_hash,expires_at)
      values($1,$2,$3,$4,now()+interval '365 days')`,
    [merchantId, programId, membershipId, hashAnonymousSession(secret)]);
  if (written.rowCount !== 1) throw new Error('Could not establish card session');
  return secret;
}

export async function createAnonymousCard(
  db: PoolClient, merchantId: string, programId: string, priorSession: string | undefined,
): Promise<{ status: 'existing' | 'created'; session?: string; card: NonNullable<Awaited<ReturnType<typeof existingAnonymousCard>>> }
  | { status: 'rate_limited' | 'not_published' }> {
  const published = await publicProgram(db, merchantId, programId);
  if (!published) return { status: 'not_published' };
  const existing = await existingAnonymousCard(db, merchantId, programId, priorSession);
  if (existing) return { status: 'existing', card: existing };

  // Serializing per program prevents quota bypass by parallel requests.
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
    ['taply:anonymous-enroll:' + programId]);
  const counts = await db.query<{ total: number }>(
    `select count(*)::integer as total from taply.memberships
      where merchant_id=$1 and program_id=$2 and created_at>now()-interval '10 minutes'`,
    [merchantId, programId]);
  if ((counts.rows[0]?.total ?? MAX_ENROLLS_10MIN) >= MAX_ENROLLS_10MIN) {
    return { status: 'rate_limited' };
  }
  // Recheck published under lock; joins enforce active program/version.
  const rule = await db.query<{ id: string }>(
    `select v.id from taply.program_rule_versions v
      join taply.loyalty_programs p on p.id=v.program_id and p.merchant_id=v.merchant_id
      join taply.program_publications pub on pub.program_id=v.program_id
        and pub.merchant_id=v.merchant_id and pub.published_at is not null
      where v.program_id=$1 and v.merchant_id=$2 and v.is_active=true and p.status='active'`,
    [programId, merchantId]);
  const ruleId = rule.rows[0]?.id;
  if (!ruleId) return { status: 'not_published' };

  const customerId = randomUUID();
  const membershipId = randomUUID();
  await db.query('insert into taply.customers(id,merchant_id) values($1,$2)',
    [customerId, merchantId]);
  await db.query(`insert into taply.memberships
    (id,merchant_id,customer_id,program_id,current_rule_version_id)
    values($1,$2,$3,$4,$5)`, [membershipId, merchantId, customerId, programId, ruleId]);
  // Defaults are 0 visits, false reward, cycle 1. No visit_ledger insert.
  await db.query('insert into taply.membership_states(membership_id,merchant_id) values($1,$2)',
    [membershipId, merchantId]);
  const session = await issueSession(db, merchantId, programId, membershipId);
  return { status: 'created', session, card: {
    membershipId, visits: 0, rewardPending: false, cycleNumber: 1,
    threshold: published.threshold,
  } };
}

export async function presentAnonymousCard(
  db: PoolClient, merchantId: string, programId: string, rawSession: string | undefined,
): Promise<{ qrToken: string; rotationPolicy: 'on_next_presentation' } | undefined> {
  const existing = await existingAnonymousCard(db, merchantId, programId, rawSession);
  if (!existing) return undefined;
  // The state lock serializes rotations; taply_app can UPDATE state, not memberships.
  await db.query('select membership_id from taply.membership_states where membership_id=$1 and merchant_id=$2 for update',
    [existing.membershipId, merchantId]);
  await db.query(`update taply.wallet_qr_tokens set revoked_at=now()
    where membership_id=$1 and merchant_id=$2 and revoked_at is null`,
    [existing.membershipId, merchantId]);
  const raw = generateWalletQrToken();
  await db.query(`insert into taply.wallet_qr_tokens(membership_id,merchant_id,token_hash)
    values($1,$2,$3)`, [existing.membershipId, merchantId, hashWalletQrToken(raw)]);
  // QR presentation does not grant any credit, even if copied.
  return { qrToken: raw, rotationPolicy: 'on_next_presentation' as const };
}

export async function generateRecovery(
  db: PoolClient, merchantId: string, programId: string, rawSession: string | undefined,
): Promise<string | undefined> {
  const existing = await existingAnonymousCard(db, merchantId, programId, rawSession);
  if (!existing) return undefined;
  const code = newRecoveryCode();
  await db.query(`insert into taply.card_recovery_secrets
    (merchant_id,program_id,membership_id,code_hash)
    values($1,$2,$3,$4)
    on conflict(membership_id) do update set
      code_hash=excluded.code_hash,updated_at=now()`,
    [merchantId, programId, existing.membershipId, recoveryHash(code)]);
  return code; // once in response; never retained in JS state after navigation
}

export async function recoverAnonymousCard(
  db: PoolClient, merchantId: string, programId: string, rawCode: string,
): Promise<{ session: string } | undefined> {
  const normalized = normaliseRecovery(rawCode);
  if (!normalized) return undefined;
  // Guard brute force per commerce; count attempts across all input codes.
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
    ['taply:recovery:' + programId]);
  const attempts = await db.query<{ attempts: number }>(`
    insert into taply.recovery_attempt_buckets(merchant_id,program_id,window_start,attempts)
      values($1,$2,date_trunc('hour',now()),1)
    on conflict (merchant_id,program_id,window_start)
      do update set attempts=taply.recovery_attempt_buckets.attempts+1
    returning attempts`, [merchantId, programId]);
  if ((attempts.rows[0]?.attempts ?? 999) > 100) return undefined;

  const found = await db.query<{ membership_id: string }>(`
    select membership_id from taply.card_recovery_secrets
      where merchant_id=$1 and program_id=$2 and code_hash=$3 for update`,
    [merchantId, programId, recoveryHash(normalized)]);
  const id = found.rows[0]?.membership_id;
  if (!id) return undefined;
  // Revoke existing sessions AND used code; new session cannot be guessed.
  await db.query(`update taply.anonymous_card_sessions set revoked_at=now()
    where merchant_id=$1 and membership_id=$2 and revoked_at is null`, [merchantId, id]);
  await db.query(`update taply.card_recovery_secrets
      set code_hash=$3,updated_at=now()
      where merchant_id=$1 and membership_id=$2`,
    [merchantId, id, recoveryHash(newRecoveryCode())]);
  // Previously presented QR cannot remain usable after recovery.
  await db.query(`update taply.wallet_qr_tokens set revoked_at=now()
    where merchant_id=$1 and membership_id=$2 and revoked_at is null`,
    [merchantId, id]);
  const session = await issueSession(db, merchantId, programId, id);
  return { session };
}
