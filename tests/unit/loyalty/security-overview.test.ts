import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../../../backend/auth/session.js';
import { securityOverview } from '../../../backend/loyalty/security-overview.js';

const owner: AuthenticatedPrincipal = {
  sessionId: 'session', merchantId: 'merchant-A',
  merchantUserId: 'employee-1', authUserId: 'auth-1', role: 'owner',
};

describe('owner security overview', () => {
  it('refuse staff avant le premier SELECT', async () => {
    const query = vi.fn();
    const result = await securityOverview({ query } as unknown as PoolClient, {
      ...owner, role: 'staff',
    });
    expect(result).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('expose les actions et appareils de son seul commerce sans secrets', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'dev-1', merchant_user_id: 'employee-1',
        role: 'owner', status: 'active', failed_attempts: 2,
        locked_until: null, revoked_at: null, last_used_at: null,
        created_at: new Date('2026-10-08T09:00:00Z'),
        token_hash: 'DO-NOT-EXPOSE', pin_verifier: 'SECRET', pin_salt: 'SECRET',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'event-1', kind: 'visit', membership_id: 'member-1',
        performed_by: 'employee-1', happened_at: new Date('2026-10-08T09:00:00Z'),
      }] })
      .mockResolvedValueOnce({ rows: [{ merchant_user_id: 'employee-1', count: 19 }] });
    const result = await securityOverview({ query } as unknown as PoolClient, owner);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.every((call: unknown[]) => (call[1] as unknown[])[0] === owner.merchantId)).toBe(true);
    expect(result?.devices[0]).toMatchObject({
      id: 'dev-1', merchantUserId: 'employee-1', failedAttempts: 2,
    });
    expect(result?.recentActivity[0]).toMatchObject({
      kind: 'visit', membershipId: 'member-1', performedBy: 'employee-1',
    });
    expect(result?.unusualVelocity[0]).toEqual({
      merchantUserId: 'employee-1', visitsIn10Minutes: 19,
    });
    const json = JSON.stringify(result);
    for (const sensitive of ['token_hash', 'pin_verifier', 'pin_salt', 'DO-NOT-EXPOSE', 'SECRET']) {
      expect(json).not.toContain(sensitive);
    }
    for (const [sql] of query.mock.calls as [string, unknown[]][]) {
      expect(sql).toContain('merchant_id=$1');
      expect(sql).not.toMatch(/select\s+\*/i);
    }
  });

  it('renvoie un tableau vide quand aucune activité/appareil', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await securityOverview({ query } as unknown as PoolClient, owner);
    expect(result).toEqual({ devices: [], recentActivity: [], unusualVelocity: [] });
  });
});
