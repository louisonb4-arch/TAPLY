/**
 * Configuration du programme par le propriétaire (onboarding + dashboard).
 *
 * Cycle de vie :
 *   brouillon  → seuil/récompenses/apparence modifiables librement (aucune
 *                carte ne peut exister avant publication) ;
 *   publication → QR commerçant activé, contrat figé (contract_changed_at) ;
 *   publié     → apparence, conditions affichées, nom : modifiables à tout
 *                moment ; seuil/récompenses : une nouvelle version au plus
 *                tous les 30 jours (rules.ts + trigger en base). Les cartes
 *                en cours gardent la version de leur cycle.
 *
 * Toutes les fonctions : transaction authentifiée, RLS tenant, rôle owner.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { decideRuleChange } from './rules.js';
import { merchantEnrollmentUrl } from './public-enrollment-token.js';
import {
  buildStoredRules, parseStoredContract, sameContract,
  type ContractInput, type RewardOption,
} from './program-rules.js';
import { RULE_CHANGE_DELAY_MS } from './types.js';

type SetupRow = {
  id: string; name: string; status: string; merchant_name: string; city: string | null;
  rule_id: string; version_no: number; rules: unknown; rule_created_at: Date | string;
  reward_title: string | null; reward_terms: string | null; terms_version: number | null;
  card_color: string | null; text_color: string | null;
  published_at: Date | string | null; contract_changed_at: Date | string | null;
  public_token: string | null; public_link_status: string | null;
  nfc_auto_enabled: boolean | null; notify_reward_unlocked: boolean | null; notifications_enabled: boolean | null;
  active_tags: number; members: number; db_now: Date | string;
};

const SQL = `select p.id, p.name, p.status, m.name as merchant_name, m.city,
    v.id as rule_id, v.version_no, v.rules, v.created_at as rule_created_at,
    pub.reward_title, pub.reward_terms, pub.terms_version, pub.card_color, pub.text_color,
    pub.published_at, pub.contract_changed_at,
    l.public_token, l.status as public_link_status,
    pref.nfc_auto_enabled, pref.notify_reward_unlocked, pref.notifications_enabled,
    (select count(*)::integer from taply.nfc_tags t
      where t.merchant_id = p.merchant_id and t.program_id = p.id and t.status = 'active') as active_tags,
    (select count(*)::integer from taply.memberships ms
      where ms.merchant_id = p.merchant_id and ms.program_id = p.id) as members,
    now() as db_now
  from taply.loyalty_programs p
  join taply.merchants m on m.id = p.merchant_id
  join taply.program_rule_versions v on v.merchant_id = p.merchant_id
    and v.program_id = p.id and v.is_active = true
  left join taply.program_publications pub on pub.merchant_id = p.merchant_id
    and pub.program_id = p.id
  left join taply.program_preferences pref on pref.merchant_id = p.merchant_id
    and pref.program_id = p.id
  left join lateral (select public_token, status
      from taply.public_enrollment_links
      where merchant_id = p.merchant_id and program_id = p.id
      order by created_at, id limit 1) l on true
  where p.merchant_id = $1 and p.status <> 'archived'
  order by p.created_at, p.id limit 1`;

async function lookup(client: PoolClient, principal: AuthenticatedPrincipal): Promise<SetupRow | undefined> {
  if (principal.role !== 'owner') return undefined;
  const data = await client.query<SetupRow>(SQL, [principal.merchantId]);
  return data.rows[0];
}

async function lockProgram(client: PoolClient, principal: AuthenticatedPrincipal, programId: string): Promise<SetupRow | undefined> {
  await client.query('select id from taply.loyalty_programs where id = $1 and merchant_id = $2 for update',
    [programId, principal.merchantId]);
  return lookup(client, principal);
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

function contractLock(row: SetupRow): { changedAt: string | null; lockedUntil: string | null; canChangeNow: boolean } {
  if (!row.published_at) return { changedAt: null, lockedUntil: null, canChangeNow: true };
  const changedAt = iso(row.contract_changed_at ?? row.published_at);
  if (changedAt === null) return { changedAt: null, lockedUntil: null, canChangeNow: true };
  const until = new Date(new Date(changedAt).getTime() + RULE_CHANGE_DELAY_MS);
  const now = new Date(row.db_now).getTime();
  return { changedAt, lockedUntil: until.toISOString(), canChangeNow: now >= until.getTime() };
}

export async function readMerchantSetup(client: PoolClient, principal: AuthenticatedPrincipal, origin: string) {
  const row = await lookup(client, principal);
  if (!row) return undefined;
  const contract = parseStoredContract(row.rules, row.reward_title);
  const published = Boolean(row.published_at && row.public_link_status === 'active');
  const versions = await client.query<{ version_no: number; rules: unknown; created_at: Date | string; is_active: boolean; change_reason: string | null }>(
    `select version_no, rules, created_at, is_active, change_reason from taply.program_rule_versions
      where merchant_id = $1 and program_id = $2 order by version_no desc limit 12`,
    [principal.merchantId, row.id],
  );
  return {
    programId: row.id,
    programName: row.name,
    programStatus: row.status,
    merchantName: row.merchant_name,
    city: row.city,
    threshold: contract?.threshold ?? null,
    rewards: contract?.rewards ?? [],
    rewardTerms: row.reward_terms ?? '',
    termsVersion: row.terms_version ?? 1,
    cardColor: row.card_color ?? '#10241A',
    textColor: row.text_color ?? '#FFFFFF',
    published,
    publishedAt: iso(row.published_at),
    hasEnrollmentLink: Boolean(row.public_token),
    enrollmentUrl: published && row.public_token ? merchantEnrollmentUrl(origin, row.public_token) : null,
    contract: contractLock(row),
    versions: versions.rows.map((v) => {
      const parsed = parseStoredContract(v.rules, row.reward_title);
      return { versionNo: v.version_no, active: v.is_active, createdAt: iso(v.created_at),
        threshold: parsed?.threshold ?? null, rewards: parsed?.rewards.map((r) => r.title) ?? [],
        reason: v.change_reason };
    }),
    preferences: {
      nfcAutoEnabled: row.nfc_auto_enabled === true,
      notifyRewardUnlocked: row.notify_reward_unlocked !== false,
      notificationsEnabled: row.notifications_enabled === true,
    },
    activeNfcTags: row.active_tags,
    cardsCount: row.members,
  };
}

export interface DraftInput extends ContractInput {
  readonly rewardTerms: string;
  readonly cardColor: string;
  readonly textColor: string;
}

async function insertVersion(
  client: PoolClient, principal: AuthenticatedPrincipal, row: SetupRow,
  rules: { threshold: number; rewards: RewardOption[] }, reason: string | null,
): Promise<void> {
  const disabled = await client.query(
    'update taply.program_rule_versions set is_active = false where id = $1 and merchant_id = $2 and is_active = true',
    [row.rule_id, principal.merchantId]);
  if (disabled.rowCount !== 1) throw new Error('Rule version race');
  await client.query(
    `insert into taply.program_rule_versions
       (id, merchant_id, program_id, version_no, rules, is_active, created_by, change_reason)
     values ($1, $2, $3, $4, $5::jsonb, true, $6, $7)`,
    [randomUUID(), principal.merchantId, row.id, row.version_no + 1, JSON.stringify(rules),
      principal.merchantUserId, reason]);
}

/** Brouillon (avant publication) : tout est modifiable, aucune carte n'existe. */
export async function saveMerchantSetup(
  client: PoolClient, principal: AuthenticatedPrincipal, input: DraftInput,
): Promise<'updated' | 'not_found' | 'locked' | 'invalid'> {
  const first = await lookup(client, principal);
  if (!first) return 'not_found';
  const row = await lockProgram(client, principal, first.id);
  if (!row) return 'not_found';
  if (row.published_at) return 'locked';
  const rules = buildStoredRules(input);
  if (rules === null) return 'invalid';
  const current = parseStoredContract(row.rules, row.reward_title);
  if (current === null || !sameContract(current, rules)) {
    if (row.members > 0) return 'locked';
    await insertVersion(client, principal, row, rules, 'Brouillon');
  }
  const firstReward = rules.rewards[0]?.title ?? null;
  const changed = await client.query(
    `insert into taply.program_publications
      (program_id, merchant_id, reward_title, reward_terms, card_color, text_color)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (program_id) do update set
        reward_title = excluded.reward_title, reward_terms = excluded.reward_terms,
        card_color = excluded.card_color, text_color = excluded.text_color, updated_at = now()
      where taply.program_publications.published_at is null`,
    [row.id, principal.merchantId, firstReward, input.rewardTerms, input.cardColor, input.textColor]);
  return changed.rowCount === 1 ? 'updated' : 'locked';
}

export async function publishMerchantSetup(
  client: PoolClient, principal: AuthenticatedPrincipal,
): Promise<'published' | 'not_found' | 'incomplete'> {
  const first = await lookup(client, principal);
  if (!first) return 'not_found';
  const row = await lockProgram(client, principal, first.id);
  const contract = row ? parseStoredContract(row.rules, row.reward_title) : null;
  if (!row || row.status !== 'active' || contract === null || contract.rewards.length === 0
      || !row.reward_title?.trim() || !row.public_token) return 'incomplete';
  if (!row.published_at) {
    await client.query(
      `update taply.program_publications
          set published_at = now(), contract_changed_at = now(), updated_at = now()
        where program_id = $1 and merchant_id = $2 and published_at is null and reward_title is not null`,
      [row.id, principal.merchantId]);
  }
  const updated = await client.query(
    `update taply.public_enrollment_links set status = 'active', updated_at = now()
       where merchant_id = $1 and program_id = $2 and public_token = $3`,
    [principal.merchantId, row.id, row.public_token]);
  if (updated.rowCount !== 1) throw new Error('Public link publication mismatch');
  return 'published';
}

export type ContractUpdateResult =
  | { readonly status: 'updated'; readonly versionNo: number; readonly nextChangeAt: string }
  | { readonly status: 'unchanged' | 'not_found' | 'not_published' | 'invalid' }
  | { readonly status: 'too_soon'; readonly allowedAfter: string };

/**
 * Modification contractuelle d'un programme publié (seuil, récompenses).
 * Une fois tous les 30 jours au plus ; progression acquise conservée
 * (les cartes en cycle gardent leur version jusqu'à la remise).
 */
export async function updateProgramContract(
  client: PoolClient, principal: AuthenticatedPrincipal, input: ContractInput & { reason?: string },
): Promise<ContractUpdateResult> {
  const first = await lookup(client, principal);
  if (!first) return { status: 'not_found' };
  const row = await lockProgram(client, principal, first.id);
  if (!row) return { status: 'not_found' };
  if (!row.published_at) return { status: 'not_published' };
  const rules = buildStoredRules(input);
  if (rules === null) return { status: 'invalid' };
  const current = parseStoredContract(row.rules, row.reward_title);
  if (current !== null && sameContract(current, rules)) return { status: 'unchanged' };
  const lock = contractLock(row);
  const decision = decideRuleChange({ threshold: rules.threshold }, lock.changedAt ?? iso(row.db_now) ?? '',
    new Date(row.db_now).toISOString());
  if (!decision.allowed) {
    if (decision.reason.kind === 'change_too_soon') return { status: 'too_soon', allowedAfter: decision.reason.allowedAfter };
    return { status: 'invalid' };
  }
  await insertVersion(client, principal, row, rules, input.reason?.trim().slice(0, 200) || null);
  await client.query(
    `update taply.program_publications
        set contract_changed_at = now(), reward_title = $3, updated_at = now()
      where program_id = $1 and merchant_id = $2`,
    [row.id, principal.merchantId, rules.rewards[0]?.title ?? row.reward_title]);
  return { status: 'updated', versionNo: row.version_no + 1,
    nextChangeAt: new Date(new Date(row.db_now).getTime() + RULE_CHANGE_DELAY_MS).toISOString() };
}

export interface AppearanceInput {
  readonly cardColor: string;
  readonly textColor: string;
  readonly rewardTerms: string;
  readonly merchantName: string;
  readonly city: string | null;
}

/** Informations non contractuelles : modifiables à tout moment. */
export async function updateAppearance(
  client: PoolClient, principal: AuthenticatedPrincipal, input: AppearanceInput,
): Promise<'updated' | 'not_found'> {
  const row = await lookup(client, principal);
  if (!row) return 'not_found';
  const merchant = await client.query(
    'update taply.merchants set name = $2, city = $3, updated_at = now() where id = $1',
    [principal.merchantId, input.merchantName, input.city]);
  if (merchant.rowCount !== 1) return 'not_found';
  const termsChanged = (row.reward_terms ?? '') !== input.rewardTerms;
  await client.query(
    `insert into taply.program_publications (program_id, merchant_id, reward_terms, card_color, text_color)
     values ($1, $2, $3, $4, $5)
     on conflict (program_id) do update set
       reward_terms = excluded.reward_terms, card_color = excluded.card_color, text_color = excluded.text_color,
       terms_version = taply.program_publications.terms_version + $6, updated_at = now()`,
    [row.id, principal.merchantId, input.rewardTerms, input.cardColor, input.textColor,
      termsChanged && row.published_at ? 1 : 0]);
  return 'updated';
}

export interface PreferencesInput {
  readonly nfcAutoEnabled: boolean;
  readonly notifyRewardUnlocked: boolean;
  readonly notificationsEnabled: boolean;
}

export async function updatePreferences(
  client: PoolClient, principal: AuthenticatedPrincipal, input: PreferencesInput,
): Promise<'updated' | 'not_found' | 'nfc_requires_active_tag'> {
  const row = await lookup(client, principal);
  if (!row) return 'not_found';
  if (input.nfcAutoEnabled && row.active_tags === 0) return 'nfc_requires_active_tag';
  await client.query(
    `insert into taply.program_preferences
       (merchant_id, program_id, notifications_enabled, nfc_auto_enabled, notify_reward_unlocked)
     values ($1, $2, $3, $4, $5)
     on conflict (program_id) do update set
       notifications_enabled = excluded.notifications_enabled,
       nfc_auto_enabled = excluded.nfc_auto_enabled,
       notify_reward_unlocked = excluded.notify_reward_unlocked,
       updated_at = now()`,
    [principal.merchantId, row.id, input.notificationsEnabled, input.nfcAutoEnabled, input.notifyRewardUnlocked]);
  return 'updated';
}
