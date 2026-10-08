/**
 * Accueil commerçant : indicateurs réels + checklist calculée en base.
 * Lecture seule, sous la même transaction / RLS que la session Taply.
 *
 * L'approbation d'un appareil ne signifie PAS que le présentoir NFC est
 * branché ou que le navigateur courant possède le cookie de cet appareil.
 * Le NFC physique et l'envoi de notifications ne sont pas suivis par V1.
 */
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { merchantOverview } from './operations.js';
import { isValidThreshold } from './rules.js';

const ACTIVITY_LIMIT = 8;

type SetupStepId = 'program' | 'staff_device' | 'first_card' | 'first_visit';

interface CountsRow {
  readonly visits: number;
  readonly rewards_redeemed: number;
  readonly approved_devices: number;
  readonly usable_devices: number;
}

interface ActivityRow {
  readonly kind: 'visit' | 'reward';
  readonly happened_at: Date;
}

export async function merchantHome(client: PoolClient, principal: AuthenticatedPrincipal) {
  // Rôle testé AVANT toute lecture. Le SQL filtre également merchant_id ;
  // les politiques FORCE RLS constituent une frontière indépendante.
  if (principal.role !== 'owner') return undefined;

  const programs = await merchantOverview(client, principal);
  const [countResult, activityResult] = await Promise.all([
    client.query<CountsRow>(
      `select
         (select count(*)::integer from taply.visit_ledger
           where merchant_id=$1) as visits,
         (select count(*)::integer from taply.redemption_ledger
           where merchant_id=$1) as rewards_redeemed,
         (select count(*)::integer from taply.staff_devices
           where merchant_id=$1 and revoked_at is null) as approved_devices,
         (select count(*)::integer from taply.staff_devices
           where merchant_id=$1 and revoked_at is null
             and (locked_until is null or locked_until <= now())) as usable_devices`,
      [principal.merchantId],
    ),
    client.query<ActivityRow>(
      `select kind, happened_at
         from (
           select 'visit'::text as kind, credited_at as happened_at
             from taply.visit_ledger where merchant_id=$1
           union all
           select 'reward'::text as kind, redeemed_at as happened_at
             from taply.redemption_ledger where merchant_id=$1
         ) recent
        order by happened_at desc, kind desc
        limit $2`,
      [principal.merchantId, ACTIVITY_LIMIT],
    ),
  ]);
  const counts = countResult.rows[0];
  if (!counts) throw new Error('Merchant home counters unavailable');

  const preferredProgram = programs.find(p => p.status === 'active') ?? programs[0] ?? null;
  const totalCards = programs.reduce((sum, p) => sum + p.totalMembers, 0);
  const totalPending = programs.reduce((sum, p) => sum + p.pendingRewards, 0);
  const totalActivePrograms = programs.filter(p => p.status === 'active').length;

  const steps: readonly { id: SetupStepId; completed: boolean }[] = [
    { id: 'program', completed: programs.some(p => p.status === 'active' && isValidThreshold(p.threshold ?? -1)) },
    { id: 'staff_device', completed: counts.usable_devices > 0 },
    { id: 'first_card', completed: totalCards > 0 },
    { id: 'first_visit', completed: counts.visits > 0 },
  ];
  return {
    version: 1 as const,
    program: preferredProgram === null ? null : {
      id: preferredProgram.id,
      name: preferredProgram.name,
      status: preferredProgram.status,
      threshold: preferredProgram.threshold,
      notificationsPreference: preferredProgram.notificationsEnabled,
    },
    stats: {
      cardsRegistered: totalCards,
      visitsValidated: counts.visits,
      rewardsPending: totalPending,
      rewardsRedeemed: counts.rewards_redeemed,
      activePrograms: totalActivePrograms,
    },
    onboarding: {
      completed: steps.filter(step => step.completed).length,
      total: steps.length,
      steps,
    },
    devices: {
      approvedCount: counts.approved_devices,
      usableCount: counts.usable_devices,
      // La liaison d'un présentoir physique n'est pas instrumentée.
      presenterStatus: 'not_tracked' as const,
    },
    capabilities: {
      notificationsSending: false,
      walletPassIssuance: false,
      nfcHardwareProvisioning: false,
    },
    recentActivity: activityResult.rows.map(row => ({
      kind: row.kind,
      happenedAt: row.happened_at,
    })),
    recentActivityLimit: ACTIVITY_LIMIT,
  };
}
