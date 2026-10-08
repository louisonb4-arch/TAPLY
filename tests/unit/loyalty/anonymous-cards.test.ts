import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  newAnonymousSession,hashAnonymousSession,newRecoveryCode,recoveryHash,
  normaliseRecovery,clientSessionCookieName,createAnonymousCard,
  existingAnonymousCard,
} from '../../../backend/loyalty/anonymous-cards.js';

const merchant = '11111111-1111-4111-8111-111111111111';
const program = '22222222-2222-4222-8222-222222222222';

function mockDB(rate=0) {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    sqls.push(sql);
    if (sql.includes('as merchant_name')) return { rows: [{
      id: program, merchant_name: 'Café test', threshold: 7,
      reward_title: 'Un café offert', reward_terms: '1 passage par achat',
    }] };
    if (sql.includes('from taply.anonymous_card_sessions s')) return { rows: [] };
    if (sql.includes('count(*)::integer as total')) return { rows: [{total:rate}] };
    if (sql.includes('select v.id from taply.program_rule_versions')) return { rows: [{id:'33333333-3333-4333-8333-333333333333'}] };
    return { rowCount:1,rows:[] };
  });
  return { db:{query} as unknown as PoolClient,query,sqls };
}

describe('QR V1 anonymous cards',()=>{
  it('issues high-entropy tokens without names or identity fields',()=>{
    const sessions=Array.from({length:100},newAnonymousSession);
    expect(new Set(sessions).size).toBe(100);
    expect(sessions.every(s=>/^[A-Za-z0-9_-]{43}$/.test(s))).toBe(true);
    expect(hashAnonymousSession(sessions[0]!)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAnonymousSession(sessions[0]!)).not.toBe(sessions[0]);
    const codes=Array.from({length:200},newRecoveryCode);
    expect(new Set(codes).size).toBe(200);
    expect(codes.every(s=>/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/.test(s))).toBe(true);
    expect(recoveryHash(codes[0]!)).toMatch(/^[0-9a-f]{64}$/);
    expect(normaliseRecovery(codes[0]!.match(/.{1,5}/g)!.join('-'))).toBe(codes[0]);
    expect(normaliseRecovery('invalid')).toBeUndefined();
    expect(clientSessionCookieName(program)).not.toBe(clientSessionCookieName(merchant));
  });

  it('creates membership at zero without any name/profile, visit, or reward write',async()=>{
    const {db,query,sqls}=mockDB();
    const result=await createAnonymousCard(db,merchant,program,undefined);
    expect(result.status).toBe('created');
    if(result.status!=='created')return;
    expect(result.card.visits).toBe(0);
    expect(result.card.rewardPending).toBe(false);
    expect(result.card.threshold).toBe(7);
    expect(result.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sqls.some(sql=>sql.includes('insert into taply.customers'))).toBe(true);
    expect(sqls.some(sql=>sql.includes('insert into taply.memberships'))).toBe(true);
    expect(sqls.some(sql=>sql.includes('insert into taply.membership_states'))).toBe(true);
    expect(sqls.join(' ').toLowerCase()).not.toMatch(/insert into taply\.(visit_ledger|redemption_ledger|customer_profiles|wallet_qr_tokens)/);
    for (const call of query.mock.calls) {
      const params = call[1] as unknown[] | undefined;
      if(params) expect(params).not.toContain('firstName');
    }
  });

  it('rejects enrollment once quota is reached without creating a customer',async()=>{
    const {db,sqls}=mockDB(100);
    const result=await createAnonymousCard(db,merchant,program,undefined);
    expect(result.status).toBe('rate_limited');
    expect(sqls.some(sql=>sql.includes('insert into taply.customers'))).toBe(false);
  });

  it('ignores empty/malformed client session tokens',async()=>{
    const {db,query}=mockDB();
    expect(await existingAnonymousCard(db,merchant,program,undefined)).toBeUndefined();
    expect(await existingAnonymousCard(db,merchant,program,'bad')).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
