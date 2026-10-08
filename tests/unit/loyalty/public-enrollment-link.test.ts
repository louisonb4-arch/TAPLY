import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { ensureMerchantPublicLink, getMerchantPublicLink } from '../../../backend/loyalty/public-enrollment-link.js';
import type { AuthenticatedPrincipal } from '../../../backend/auth/session.js';

const owner: AuthenticatedPrincipal = {
  role:'owner',
  merchantId:'11111111-1111-4111-8111-111111111111',
  merchantUserId:'22222222-2222-4222-8222-222222222222',
  authUserId:'33333333-3333-4333-8333-333333333333',
  sessionId:'44444444-4444-4444-8444-444444444444',
};
const staff = { ...owner, role:'staff' as const };

function mockDb(rows:(sql:string,values:unknown[])=>unknown[]) {
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>({
    rows:rows(sql,values),rowCount:1,
  }));
  return { client:{query} as unknown as PoolClient, query };
}

describe('Lien QR propriétaire — transactions sous RLS',()=>{
  it('un employé ne peut ni consulter ni créer de lien',async()=>{
    const {client,query}=mockDb(()=>[]);
    expect(await getMerchantPublicLink(client,staff)).toBeNull();
    expect(await ensureMerchantPublicLink(client,staff)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it('un lien existant est relu sans mutation ni rotation du jeton',async()=>{
    const {client,query}=mockDb(sql=>sql.includes('from taply.public_enrollment_links') ?
      [{public_token:'public-token-unique',program_id:'p',location_id:'l'}] : []);
    const result=await ensureMerchantPublicLink(client,owner);
    expect(result).toEqual({publicToken:'public-token-unique',programId:'p',locationId:'l',created:false});
    expect(query.mock.calls.some(call=>String(call[0]).includes('insert into'))).toBe(false);
    expect(query.mock.calls.some(call=>String(call[0]).includes('pg_advisory_xact_lock'))).toBe(true);
  });
  it('crée un emplacement et un lien de 160 bits si aucun ne préexiste',async()=>{
    const {client,query}=mockDb(sql=>{
      if(sql.includes('from taply.public_enrollment_links'))return [];
      if(sql.includes('from taply.merchants'))return [{id:owner.merchantId}];
      if(sql.includes('from taply.loyalty_programs'))return [{id:'program-id'}];
      if(sql.includes('from taply.locations'))return [];
      if(sql.includes('insert into taply.locations'))return [{id:'location-id'}];
      return [];
    });
    const result=await ensureMerchantPublicLink(client,owner);
    expect(result?.created).toBe(true);
    expect(result?.publicToken).toMatch(/^[A-Za-z0-9_-]{27}$/);
    const insert=query.mock.calls.find(x=>String(x[0]).includes('insert into taply.public_enrollment_links'));
    expect(insert).toBeDefined();
    expect(insert?.[1]).toEqual([result?.publicToken,owner.merchantId,'location-id','program-id']);
  });
  it('ne crée aucun lien pour un commerce sans programme actif',async()=>{
    const {client,query}=mockDb(sql=>sql.includes('from taply.merchants')?[{id:owner.merchantId}]:[]);
    expect(await ensureMerchantPublicLink(client,owner)).toBeNull();
    expect(query.mock.calls.some(x=>String(x[0]).includes('insert into'))).toBe(false);
  });
});
