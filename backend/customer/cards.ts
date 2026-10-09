/**
 * Cartes de fidélité d'une identité anonyme.
 *
 * Chaque fonction tourne dans UNE transaction où le serveur a posé
 * app.merchant_id (commerce résolu depuis un lien public, une puce NFC ou
 * le lien identité→carte) ET app.identity_id (cookie vérifié). Aucune de
 * ces fonctions ne crédite un passage : seul le moteur credit.ts le fait.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { generateWalletQrToken, hashWalletQrToken } from '../loyalty/qr-token.js';
import { parseStoredContract, type RewardOption } from '../loyalty/program-rules.js';
import { VISIT_COOLDOWN_MS } from '../loyalty/types.js';
import { consumeRateLimit } from '../security/rate-limit.js';

/** QR personnel de la carte web : temporaire, renouvelé à chaque affichage. */
export const WEB_QR_TTL_SECONDS = 15 * 60;
/** Création de cartes par programme (anti-inscriptions massives). */
export const ENROLLMENTS_PER_PROGRAM_10MIN = 120;
export const ENROLLMENTS_PER_IP_HOUR = 20;

export interface PublicProgramView {
  readonly programId: string;
  readonly merchantName: string;
  readonly city: string | null;
  readonly threshold: number;
  readonly rewards: readonly RewardOption[];
  readonly terms: string;
  readonly cardColor: string;
  readonly textColor: string;
  readonly nfcAutoEnabled: boolean;
}

interface ProgramRow {
  merchant_name: string;
  city: string | null;
  rules: unknown;
  reward_title: string | null;
  reward_terms: string;
  card_color: string;
  text_color: string;
  nfc_auto_enabled: boolean | null;
}

/** Programme publié et actif, sinon undefined (même réponse dans tous les cas). */
export async function publicProgramView(
  client: PoolClient, merchantId: string, programId: string,
): Promise<PublicProgramView | undefined> {
  const result = await client.query<ProgramRow>(
    `select mer.name as merchant_name, mer.city, v.rules, pub.reward_title, pub.reward_terms,
            pub.card_color, pub.text_color, pref.nfc_auto_enabled
       from taply.loyalty_programs p
       join taply.merchants mer on mer.id = p.merchant_id
       join taply.program_publications pub on pub.program_id = p.id
        and pub.merchant_id = p.merchant_id and pub.published_at is not null
       join taply.program_rule_versions v on v.program_id = p.id
        and v.merchant_id = p.merchant_id and v.is_active = true
       left join taply.program_preferences pref on pref.program_id = p.id
        and pref.merchant_id = p.merchant_id
      where p.id = $1 and p.merchant_id = $2 and p.status = 'active' and mer.status = 'active'`,
    [programId, merchantId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const contract = parseStoredContract(row.rules, row.reward_title);
  if (contract === null || contract.rewards.length === 0) return undefined;
  return {
    programId,
    merchantName: row.merchant_name,
    city: row.city,
    threshold: contract.threshold,
    rewards: contract.rewards,
    terms: row.reward_terms,
    cardColor: row.card_color,
    textColor: row.text_color,
    nfcAutoEnabled: row.nfc_auto_enabled === true,
  };
}

/** Carte de cette identité pour ce programme (lien identité → carte). */
export async function findIdentityCard(client: PoolClient, identityId: string, programId: string): Promise<string | undefined> {
  const result = await client.query<{ membership_id: string }>(
    `select membership_id from taply.identity_memberships
      where identity_id = $1 and program_id = $2`,
    [identityId, programId],
  );
  return result.rows[0]?.membership_id;
}

export interface CardView {
  readonly membershipId: string;
  readonly shortCode: string;
  readonly programId: string;
  readonly merchantName: string;
  readonly city: string | null;
  readonly cardColor: string;
  readonly textColor: string;
  readonly visits: number;
  readonly threshold: number;
  readonly cycleNumber: number;
  readonly rewardPending: boolean;
  readonly rewards: readonly RewardOption[];
  readonly claim: { readonly key: string; readonly title: string; readonly chosenAt: string } | null;
  readonly lastVisitAt: string | null;
  readonly nextVisitAllowedAt: string | null;
  readonly rewardsRedeemed: number;
  readonly status: 'active' | 'inactive';
}

interface CardRow {
  membership_id: string;
  program_id: string;
  merchant_name: string;
  city: string | null;
  card_color: string | null;
  text_color: string | null;
  visit_count: number;
  reward_pending: boolean;
  cycle_number: number;
  last_credited_at: Date | string | null;
  pinned_rules: unknown;
  reward_title: string | null;
  claim_key: string | null;
  claim_title: string | null;
  claim_at: Date | string | null;
  redeemed: number;
  status: string;
  db_now: Date | string;
}

export function shortCardCode(membershipId: string): string {
  return membershipId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

const iso = (v: Date | string | null): string | null => v === null ? null : new Date(v).toISOString();

export async function cardView(client: PoolClient, merchantId: string, membershipId: string): Promise<CardView | undefined> {
  const result = await client.query<CardRow>(
    `select m.id as membership_id, m.program_id, mer.name as merchant_name, mer.city,
            pub.card_color, pub.text_color, s.visit_count, s.reward_pending, s.cycle_number,
            s.last_credited_at, v.rules as pinned_rules, pub.reward_title,
            c.reward_key as claim_key, c.reward_title as claim_title, c.chosen_at as claim_at,
            (select count(*)::integer from taply.redemption_ledger r
              where r.membership_id = m.id and r.merchant_id = m.merchant_id) as redeemed,
            m.status, now() as db_now
       from taply.memberships m
       join taply.merchants mer on mer.id = m.merchant_id
       join taply.membership_states s on s.membership_id = m.id and s.merchant_id = m.merchant_id
       join taply.program_rule_versions v on v.id = m.current_rule_version_id
        and v.merchant_id = m.merchant_id and v.program_id = m.program_id
       left join taply.program_publications pub on pub.program_id = m.program_id
        and pub.merchant_id = m.merchant_id
       left join taply.reward_claims c on c.membership_id = m.id and c.merchant_id = m.merchant_id
        and c.cycle_number = s.cycle_number and c.status = 'awaiting_handover'
      where m.id = $1 and m.merchant_id = $2`,
    [membershipId, merchantId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const contract = parseStoredContract(row.pinned_rules, row.reward_title);
  if (contract === null) return undefined;
  const last = iso(row.last_credited_at);
  const now = new Date(row.db_now).getTime();
  const nextAllowed = last === null ? null : new Date(new Date(last).getTime() + VISIT_COOLDOWN_MS);
  return {
    membershipId: row.membership_id,
    shortCode: shortCardCode(row.membership_id),
    programId: row.program_id,
    merchantName: row.merchant_name,
    city: row.city,
    cardColor: row.card_color ?? '#10241A',
    textColor: row.text_color ?? '#FFFFFF',
    visits: row.visit_count,
    threshold: contract.threshold,
    cycleNumber: row.cycle_number,
    rewardPending: row.reward_pending,
    rewards: contract.rewards,
    claim: row.claim_key === null || row.claim_title === null ? null
      : { key: row.claim_key, title: row.claim_title, chosenAt: iso(row.claim_at) ?? '' },
    lastVisitAt: last,
    nextVisitAllowedAt: nextAllowed !== null && nextAllowed.getTime() > now ? nextAllowed.toISOString() : null,
    rewardsRedeemed: row.redeemed,
    status: row.status === 'active' ? 'active' : 'inactive',
  };
}

export type EnrollResult =
  | { readonly status: 'existing' | 'created'; readonly membershipId: string }
  | { readonly status: 'not_published' | 'rate_limited' };

/**
 * Crée (ou retrouve) la carte de l'identité pour ce programme, à 0 passage.
 * Le verrou par (identité, programme) rend l'opération idempotente face aux
 * doubles clics et requêtes simultanées ; la clé primaire
 * identity_memberships(identity_id, program_id) en est la seconde barrière.
 */
export async function enrollCard(
  client: PoolClient,
  input: { identityId: string; merchantId: string; programId: string; ipHash: string },
): Promise<EnrollResult> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))',
    ['taply:enroll:' + input.identityId + ':' + input.programId]);
  const existing = await findIdentityCard(client, input.identityId, input.programId);
  if (existing !== undefined) return { status: 'existing', membershipId: existing };

  const rule = await client.query<{ id: string }>(
    `select v.id from taply.program_rule_versions v
       join taply.loyalty_programs p on p.id = v.program_id and p.merchant_id = v.merchant_id
       join taply.merchants mer on mer.id = p.merchant_id
       join taply.program_publications pub on pub.program_id = v.program_id
        and pub.merchant_id = v.merchant_id and pub.published_at is not null
      where v.program_id = $1 and v.merchant_id = $2 and v.is_active = true
        and p.status = 'active' and mer.status = 'active'`,
    [input.programId, input.merchantId],
  );
  const ruleId = rule.rows[0]?.id;
  if (ruleId === undefined) return { status: 'not_published' };

  if (!await consumeRateLimit(client, 'enroll-program:' + input.programId, ENROLLMENTS_PER_PROGRAM_10MIN, 600)
      || !await consumeRateLimit(client, 'enroll-ip:' + input.ipHash, ENROLLMENTS_PER_IP_HOUR, 3600)) {
    return { status: 'rate_limited' };
  }

  const customerId = randomUUID();
  const membershipId = randomUUID();
  await client.query('insert into taply.customers (id, merchant_id) values ($1, $2)', [customerId, input.merchantId]);
  await client.query(
    `insert into taply.memberships (id, merchant_id, customer_id, program_id, current_rule_version_id)
     values ($1, $2, $3, $4, $5)`,
    [membershipId, input.merchantId, customerId, input.programId, ruleId],
  );
  // 0 passage, aucune récompense, cycle 1 : valeurs par défaut. Aucun ledger.
  await client.query('insert into taply.membership_states (membership_id, merchant_id) values ($1, $2)',
    [membershipId, input.merchantId]);
  const linked = await client.query(
    `insert into taply.identity_memberships (identity_id, merchant_id, program_id, membership_id)
     values ($1, $2, $3, $4)`,
    [input.identityId, input.merchantId, input.programId, membershipId],
  );
  if (linked.rowCount !== 1) throw new Error('identity card link failed');
  return { status: 'created', membershipId };
}

/** Liste des cartes de l'identité (commerces différents). Lecture identité seule. */
export async function identityCardRefs(client: PoolClient, identityId: string) {
  const result = await client.query<{ membership_id: string; merchant_id: string; program_id: string }>(
    `select membership_id, merchant_id, program_id from taply.identity_memberships
      where identity_id = $1 order by created_at desc limit 50`,
    [identityId],
  );
  return result.rows.map((r) => ({ membershipId: r.membership_id, merchantId: r.merchant_id, programId: r.program_id }));
}

/**
 * QR personnel temporaire : l'ancien est révoqué, le nouveau expire après
 * WEB_QR_TTL_SECONDS. Le présenter ne crédite rien : seul un employé
 * authentifié peut valider un passage après l'avoir scanné.
 */
export async function presentCardQr(client: PoolClient, merchantId: string, membershipId: string) {
  await client.query(
    'select membership_id from taply.membership_states where membership_id = $1 and merchant_id = $2 for update',
    [membershipId, merchantId],
  );
  await client.query(
    `update taply.wallet_qr_tokens set revoked_at = now()
      where membership_id = $1 and merchant_id = $2 and revoked_at is null`,
    [membershipId, merchantId],
  );
  const raw = generateWalletQrToken();
  const inserted = await client.query<{ expires_at: Date | string }>(
    `insert into taply.wallet_qr_tokens (membership_id, merchant_id, token_hash, expires_at)
     values ($1, $2, $3, now() + make_interval(secs => $4)) returning expires_at`,
    [membershipId, merchantId, hashWalletQrToken(raw), WEB_QR_TTL_SECONDS],
  );
  const expiresAt = inserted.rows[0]?.expires_at;
  if (expiresAt === undefined) throw new Error('personal QR insert failed');
  return { qrToken: raw, expiresAt: new Date(expiresAt).toISOString() };
}

export type ChooseRewardResult =
  | { readonly status: 'chosen'; readonly reward: RewardOption }
  | { readonly status: 'not_unlocked' | 'unknown_reward' | 'not_found' };

/**
 * Le client choisit sa récompense parmi celles de SON cycle (version épinglée).
 * Possible uniquement quand la récompense est débloquée ; modifiable tant
 * que l'équipe ne l'a pas remise (la remise est définitive, RLS l'impose).
 */
export async function chooseReward(
  client: PoolClient, merchantId: string, membershipId: string, rewardKey: string,
): Promise<ChooseRewardResult> {
  const state = await client.query<{ reward_pending: boolean; cycle_number: number; rules: unknown; reward_title: string | null }>(
    `select s.reward_pending, s.cycle_number, v.rules, pub.reward_title
       from taply.membership_states s
       join taply.memberships m on m.id = s.membership_id and m.merchant_id = s.merchant_id
       join taply.program_rule_versions v on v.id = m.current_rule_version_id and v.merchant_id = m.merchant_id
       left join taply.program_publications pub on pub.program_id = m.program_id and pub.merchant_id = m.merchant_id
      where s.membership_id = $1 and s.merchant_id = $2 and m.status = 'active'
      for update of s`,
    [membershipId, merchantId],
  );
  const row = state.rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (!row.reward_pending) return { status: 'not_unlocked' };
  const contract = parseStoredContract(row.rules, row.reward_title);
  const reward = contract?.rewards.find((r) => r.key === rewardKey);
  if (reward === undefined) return { status: 'unknown_reward' };
  const updated = await client.query(
    `update taply.reward_claims
        set reward_key = $4, reward_title = $5, chosen_by = 'customer', chosen_at = now()
      where membership_id = $1 and merchant_id = $2 and cycle_number = $3
        and status = 'awaiting_handover'`,
    [membershipId, merchantId, row.cycle_number, reward.key, reward.title],
  );
  if (updated.rowCount === 0) {
    await client.query(
      `insert into taply.reward_claims
         (membership_id, merchant_id, cycle_number, reward_key, reward_title, chosen_by)
       values ($1, $2, $3, $4, $5, 'customer')`,
      [membershipId, merchantId, row.cycle_number, reward.key, reward.title],
    );
  }
  return { status: 'chosen', reward };
}

/** Historique récent de la carte (passages et remises), sans donnée d'employé. */
export async function cardHistory(client: PoolClient, merchantId: string, membershipId: string) {
  const result = await client.query<{ kind: string; at: Date | string; detail: string | null }>(
    `select * from (
       select case when source = 'NFC' then 'visit_nfc' else 'visit_qr' end as kind,
              credited_at as at, null::text as detail
         from taply.visit_ledger where membership_id = $1 and merchant_id = $2
       union all
       select 'reward' as kind, redeemed_at as at, reward_title as detail
         from taply.redemption_ledger where membership_id = $1 and merchant_id = $2
     ) h order by at desc limit 30`,
    [membershipId, merchantId],
  );
  return result.rows.map((r) => ({ kind: r.kind, at: new Date(r.at).toISOString(), detail: r.detail }));
}
