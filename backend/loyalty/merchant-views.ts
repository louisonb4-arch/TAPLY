/**
 * Lectures commerçant (dashboard) : vraies données uniquement, sous RLS
 * tenant. Les clients sont anonymes : un code court dérivé de la carte, la
 * progression et l'historique — jamais d'identité personnelle.
 */
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { parseStoredContract } from './program-rules.js';
import { shortCardCode } from '../customer/cards.js';
import { VISIT_COOLDOWN_MS } from './types.js';

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export async function dashboardStats(client: PoolClient, principal: AuthenticatedPrincipal) {
  const counts = await client.query<{
    cards: number; active_cards: number; visits: number; visits_30d: number; nfc_visits: number;
    rewards_unlocked: number; rewards_handed: number; awaiting_handover: number; pending_choice: number;
  }>(
    `select
       (select count(*)::integer from taply.memberships where merchant_id = $1) as cards,
       (select count(*)::integer from taply.membership_states
         where merchant_id = $1 and last_credited_at > now() - interval '30 days') as active_cards,
       (select count(*)::integer from taply.visit_ledger where merchant_id = $1) as visits,
       (select count(*)::integer from taply.visit_ledger
         where merchant_id = $1 and credited_at > now() - interval '30 days') as visits_30d,
       (select count(*)::integer from taply.visit_ledger where merchant_id = $1 and source = 'NFC') as nfc_visits,
       ((select count(*)::integer from taply.redemption_ledger where merchant_id = $1)
        + (select count(*)::integer from taply.membership_states where merchant_id = $1 and reward_pending)) as rewards_unlocked,
       (select count(*)::integer from taply.redemption_ledger where merchant_id = $1) as rewards_handed,
       (select count(*)::integer from taply.reward_claims
         where merchant_id = $1 and status = 'awaiting_handover') as awaiting_handover,
       (select count(*)::integer from taply.membership_states s
         where s.merchant_id = $1 and s.reward_pending and not exists (
           select 1 from taply.reward_claims c where c.membership_id = s.membership_id
             and c.merchant_id = s.merchant_id and c.cycle_number = s.cycle_number)) as pending_choice`,
    [principal.merchantId],
  );
  const activity = await client.query<{ kind: string; at: Date | string; membership_id: string; detail: string | null }>(
    `select * from (
       select case when source = 'NFC' then 'visit_nfc' else 'visit_qr' end as kind,
              credited_at as at, membership_id, null::text as detail
         from taply.visit_ledger where merchant_id = $1
       union all
       select 'reward' as kind, redeemed_at as at, membership_id, reward_title as detail
         from taply.redemption_ledger where merchant_id = $1
       union all
       select 'card' as kind, created_at as at, id as membership_id, null::text as detail
         from taply.memberships where merchant_id = $1
     ) a order by at desc limit 15`,
    [principal.merchantId],
  );
  const daily = await client.query<{ day: string; visits: number }>(
    `select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(v.n, 0)::integer as visits
       from generate_series((now() at time zone 'Europe/Paris')::date - 13, (now() at time zone 'Europe/Paris')::date, interval '1 day') d(day)
       left join (select (credited_at at time zone 'Europe/Paris')::date as day, count(*) as n
                    from taply.visit_ledger where merchant_id = $1
                     and credited_at > now() - interval '15 days' group by 1) v on v.day = d.day::date
      order by d.day`,
    [principal.merchantId],
  );
  const c = counts.rows[0];
  if (c === undefined) throw new Error('dashboard counters unavailable');
  return {
    stats: {
      cards: c.cards, activeCards30d: c.active_cards, visits: c.visits, visits30d: c.visits_30d,
      nfcVisits: c.nfc_visits, rewardsUnlocked: c.rewards_unlocked, rewardsHandedOver: c.rewards_handed,
      rewardsAwaitingHandover: c.awaiting_handover, rewardsAwaitingChoice: c.pending_choice,
    },
    visitsByDay: daily.rows,
    recentActivity: activity.rows.map((a) => ({
      kind: a.kind, at: iso(a.at), card: shortCardCode(a.membership_id), detail: a.detail,
    })),
  };
}

interface CustomerRow {
  id: string; created_at: Date | string; visit_count: number; reward_pending: boolean; cycle_number: number;
  last_credited_at: Date | string | null; rules: unknown; reward_title: string | null;
  claim_title: string | null; redeemed: number; total_visits: number; status: string;
}

export async function customerList(client: PoolClient, principal: AuthenticatedPrincipal, search?: string) {
  const code = search?.replace(/[^0-9A-Fa-f]/g, '').toLowerCase().slice(0, 6) ?? '';
  const result = await client.query<CustomerRow>(
    `select m.id, m.created_at, s.visit_count, s.reward_pending, s.cycle_number, s.last_credited_at,
            v.rules, pub.reward_title, c.reward_title as claim_title, m.status,
            (select count(*)::integer from taply.redemption_ledger r
              where r.membership_id = m.id and r.merchant_id = m.merchant_id) as redeemed,
            (select count(*)::integer from taply.visit_ledger l
              where l.membership_id = m.id and l.merchant_id = m.merchant_id) as total_visits
       from taply.memberships m
       join taply.membership_states s on s.membership_id = m.id and s.merchant_id = m.merchant_id
       join taply.program_rule_versions v on v.id = m.current_rule_version_id and v.merchant_id = m.merchant_id
       left join taply.program_publications pub on pub.program_id = m.program_id and pub.merchant_id = m.merchant_id
       left join taply.reward_claims c on c.membership_id = m.id and c.merchant_id = m.merchant_id
        and c.cycle_number = s.cycle_number and c.status = 'awaiting_handover'
      where m.merchant_id = $1 and ($2 = '' or replace(m.id::text, '-', '') like $2 || '%')
      order by coalesce(s.last_credited_at, m.created_at) desc, m.id desc
      limit 100`,
    [principal.merchantId, code],
  );
  return result.rows.map((r) => {
    const contract = parseStoredContract(r.rules, r.reward_title);
    return {
      membershipId: r.id, code: shortCardCode(r.id), joinedAt: iso(r.created_at),
      visits: r.visit_count, threshold: contract?.threshold ?? null, cycleNumber: r.cycle_number,
      rewardPending: r.reward_pending, chosenReward: r.claim_title, rewardsRedeemed: r.redeemed,
      totalVisits: r.total_visits, lastVisitAt: iso(r.last_credited_at), status: r.status,
    };
  });
}

export async function customerHistory(client: PoolClient, principal: AuthenticatedPrincipal, membershipId: string) {
  const exists = await client.query('select 1 from taply.memberships where id = $1 and merchant_id = $2',
    [membershipId, principal.merchantId]);
  if (exists.rowCount !== 1) return undefined;
  const result = await client.query<{ kind: string; at: Date | string; cycle_number: number; detail: string | null }>(
    `select * from (
       select case when source = 'NFC' then 'visit_nfc' else 'visit_qr' end as kind,
              credited_at as at, cycle_number, null::text as detail
         from taply.visit_ledger where membership_id = $1 and merchant_id = $2
       union all
       select 'reward' as kind, redeemed_at as at, cycle_number, reward_title as detail
         from taply.redemption_ledger where membership_id = $1 and merchant_id = $2
     ) h order by at desc limit 100`,
    [membershipId, principal.merchantId],
  );
  return result.rows.map((r) => ({ kind: r.kind, at: iso(r.at), cycle: r.cycle_number, detail: r.detail }));
}

export async function rewardsBoard(client: PoolClient, principal: AuthenticatedPrincipal) {
  const pending = await client.query<{
    membership_id: string; cycle_number: number; claim_title: string | null; chosen_at: Date | string | null;
    unlocked_at: Date | string | null;
  }>(
    `select s.membership_id, s.cycle_number, c.reward_title as claim_title, c.chosen_at,
            s.last_credited_at as unlocked_at
       from taply.membership_states s
       left join taply.reward_claims c on c.membership_id = s.membership_id and c.merchant_id = s.merchant_id
        and c.cycle_number = s.cycle_number and c.status = 'awaiting_handover'
      where s.merchant_id = $1 and s.reward_pending
      order by s.last_credited_at desc limit 100`,
    [principal.merchantId],
  );
  const handed = await client.query<{ membership_id: string; redeemed_at: Date | string; reward_title: string | null; cycle_number: number }>(
    `select membership_id, redeemed_at, reward_title, cycle_number from taply.redemption_ledger
      where merchant_id = $1 order by redeemed_at desc limit 30`,
    [principal.merchantId],
  );
  return {
    pending: pending.rows.map((r) => ({
      membershipId: r.membership_id, code: shortCardCode(r.membership_id), cycle: r.cycle_number,
      chosenReward: r.claim_title, chosenAt: iso(r.chosen_at), unlockedAt: iso(r.unlocked_at),
    })),
    handedOver: handed.rows.map((r) => ({
      code: shortCardCode(r.membership_id), at: iso(r.redeemed_at), reward: r.reward_title, cycle: r.cycle_number,
    })),
  };
}

/** Vue comptoir après scan du QR personnel : rien n'est crédité ici. */
export async function counterCardView(client: PoolClient, principal: AuthenticatedPrincipal, membershipId: string) {
  const result = await client.query<{
    visit_count: number; reward_pending: boolean; cycle_number: number; last_credited_at: Date | string | null;
    rules: unknown; reward_title: string | null; claim_key: string | null; claim_title: string | null;
    status: string; db_now: Date | string;
  }>(
    `select s.visit_count, s.reward_pending, s.cycle_number, s.last_credited_at, v.rules, pub.reward_title,
            c.reward_key as claim_key, c.reward_title as claim_title, m.status, now() as db_now
       from taply.memberships m
       join taply.membership_states s on s.membership_id = m.id and s.merchant_id = m.merchant_id
       join taply.program_rule_versions v on v.id = m.current_rule_version_id and v.merchant_id = m.merchant_id
       left join taply.program_publications pub on pub.program_id = m.program_id and pub.merchant_id = m.merchant_id
       left join taply.reward_claims c on c.membership_id = m.id and c.merchant_id = m.merchant_id
        and c.cycle_number = s.cycle_number and c.status = 'awaiting_handover'
      where m.id = $1 and m.merchant_id = $2`,
    [membershipId, principal.merchantId],
  );
  const r = result.rows[0];
  if (r === undefined) return undefined;
  const contract = parseStoredContract(r.rules, r.reward_title);
  const last = iso(r.last_credited_at);
  const next = last ? new Date(new Date(last).getTime() + VISIT_COOLDOWN_MS) : null;
  return {
    code: shortCardCode(membershipId),
    visits: r.visit_count,
    threshold: contract?.threshold ?? null,
    cycleNumber: r.cycle_number,
    rewardPending: r.reward_pending,
    rewards: contract?.rewards ?? [],
    chosenReward: r.claim_key && r.claim_title ? { key: r.claim_key, title: r.claim_title } : null,
    lastVisitAt: last,
    nextVisitAllowedAt: next && next.getTime() > new Date(r.db_now).getTime() ? next.toISOString() : null,
    active: r.status === 'active',
  };
}

export async function nfcTagsView(client: PoolClient, principal: AuthenticatedPrincipal) {
  const tags = await client.query<{
    id: string; label: string; uid_hex: string; status: string; last_read_at: Date | string | null;
    verified_at: Date | string; created_at: Date | string; replaces_tag_id: string | null;
    credits_30d: number; denied_24h: number;
  }>(
    `select t.id, t.label, t.uid_hex, t.status, t.last_read_at, t.verified_at, t.created_at, t.replaces_tag_id,
            (select count(*)::integer from taply.visit_ledger l
              where l.merchant_id = t.merchant_id and l.nfc_tag_id = t.id
                and l.credited_at > now() - interval '30 days') as credits_30d,
            (select count(*)::integer from taply.nfc_tap_events e
              where e.merchant_id = t.merchant_id and e.tag_id = t.id and e.outcome like 'denied_%'
                and e.created_at > now() - interval '24 hours') as denied_24h
       from taply.nfc_tags t where t.merchant_id = $1 order by t.created_at desc`,
    [principal.merchantId],
  );
  const pairing = await client.query<{ label: string; expires_at: Date | string }>(
    `select label, expires_at from taply.nfc_pairings
      where merchant_id = $1 and consumed_at is null and expires_at > now()
      order by created_at desc limit 1`,
    [principal.merchantId],
  );
  return {
    tags: tags.rows.map((t) => ({
      id: t.id, label: t.label, uidSuffix: t.uid_hex.slice(-6), status: t.status,
      lastReadAt: iso(t.last_read_at), verifiedAt: iso(t.verified_at), createdAt: iso(t.created_at),
      replacesTagId: t.replaces_tag_id, credits30d: t.credits_30d, denied24h: t.denied_24h,
    })),
    pairing: pairing.rows[0] ? { label: pairing.rows[0].label, expiresAt: iso(pairing.rows[0].expires_at) } : null,
  };
}

export async function nfcTagEvents(client: PoolClient, principal: AuthenticatedPrincipal, tagId: string) {
  const result = await client.query<{ outcome: string; read_ctr: number; created_at: Date | string; membership_id: string | null }>(
    `select outcome, read_ctr, created_at, membership_id from taply.nfc_tap_events
      where merchant_id = $1 and tag_id = $2 order by created_at desc limit 100`,
    [principal.merchantId, tagId],
  );
  return result.rows.map((e) => ({
    outcome: e.outcome, counter: e.read_ctr, at: iso(e.created_at),
    card: e.membership_id ? shortCardCode(e.membership_id) : null,
  }));
}
