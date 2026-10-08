import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../../../backend/auth/session.js';
import { merchantHome } from '../../../backend/loyalty/merchant-home.js';

const owner: AuthenticatedPrincipal = {
  authUserId: 'auth-1',
  merchantId: 'merchant-1',
  merchantUserId: 'user-1',
  role: 'owner',
  sessionId: 'session-1',
};

function clientFixture(input: {
  programs?: unknown[];
  visits?: number;
  redeemed?: number;
  approved?: number;
  usable?: number;
  recent?: unknown[];
} = {}) {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('from taply.loyalty_programs p')) return { rows: input.programs ?? [] };
    if (sql.includes('as approved_devices')) return { rows: [{
      visits: input.visits ?? 0, rewards_redeemed: input.redeemed ?? 0,
      approved_devices: input.approved ?? 0, usable_devices: input.usable ?? 0,
      secret: 'MUST_NOT_LEAK',
    }] };
    if (sql.includes('order by happened_at desc')) return { rows: input.recent ?? [] };
    throw new Error('Unexpected SQL query');
  });
  return { query, client: { query } as unknown as PoolClient };
}

describe('merchant home — owner, tenant and real onboarding state', () => {
  it('refuses staff before any database read', async () => {
    const { client, query } = clientFixture();
    expect(await merchantHome(client, { ...owner, role: 'staff' })).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns an empty-state without inventing counters or marking setup complete', async () => {
    const { client, query } = clientFixture();
    const result = await merchantHome(client, owner);
    expect(result).toMatchObject({
      version: 1,
      program: null,
      stats: { cardsRegistered: 0, visitsValidated: 0, rewardsPending: 0,
        rewardsRedeemed: 0, activePrograms: 0 },
      onboarding: { completed: 0, total: 4 },
      devices: { approvedCount: 0, usableCount: 0, presenterStatus: 'not_tracked' },
      capabilities: { notificationsSending: false, walletPassIssuance: false, nfcHardwareProvisioning: false },
      recentActivity: [],
    });
    expect(result?.onboarding.steps.every(s => !s.completed)).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('derives every step from actual merchant data, not from browser flags', async () => {
    const { client, query } = clientFixture({
      programs: [{
        id: 'program-1', name: 'Café fidélité', status: 'active',
        rules: { threshold: 5 }, total_members: 6,
        pending_rewards: 2, notifications_enabled: true,
      }],
      visits: 8, redeemed: 1, approved: 2, usable: 1,
      recent: [
        { kind: 'visit', happened_at: new Date('2026-10-08T15:00:00Z'), membership_id: 'SECRET' },
        { kind: 'reward', happened_at: new Date('2026-10-08T14:00:00Z'), token_hash: 'SECRET' },
      ],
    });
    const result = await merchantHome(client, owner);
    expect(result?.stats).toEqual({
      cardsRegistered: 6, visitsValidated: 8, rewardsPending: 2,
      rewardsRedeemed: 1, activePrograms: 1,
    });
    expect(result?.onboarding).toMatchObject({ completed: 4, total: 4 });
    expect(result?.devices).toEqual({ approvedCount: 2, usableCount: 1, presenterStatus: 'not_tracked' });
    expect(result?.program).toMatchObject({ name: 'Café fidélité', threshold: 5, notificationsPreference: true });
    expect(result?.recentActivity).toEqual([
      { kind: 'visit', happenedAt: new Date('2026-10-08T15:00:00Z') },
      { kind: 'reward', happenedAt: new Date('2026-10-08T14:00:00Z') },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain('merchant_id');
      expect(params[0]).toBe(owner.merchantId);
      expect(sql).not.toMatch(/select\s+\*/i);
    }
    expect(query.mock.calls[2]?.[1]).toEqual([owner.merchantId, 8]);
  });

  it('does not claim a working device when all approved devices are locked', async () => {
    const { client } = clientFixture({
      programs: [{ id: 'p', name: 'Programme', status: 'active', rules: { threshold: 7 },
        total_members: 0, pending_rewards: 0, notifications_enabled: false }],
      approved: 2, usable: 0,
    });
    const result = await merchantHome(client, owner);
    expect(result?.onboarding.steps.map(s => s.completed)).toEqual([true, false, false, false]);
    expect(result?.onboarding.completed).toBe(1);
  });

  it('does not mark an invalid or paused loyalty program complete', async () => {
    const { client } = clientFixture({
      programs: [{ id: 'p', name: 'Inactive', status: 'paused', rules: { threshold: 5 },
        total_members: 0, pending_rewards: 0, notifications_enabled: false }],
    });
    const result = await merchantHome(client, owner);
    expect(result?.onboarding.completed).toBe(0);
    expect(result?.program?.status).toBe('paused');
  });
});
