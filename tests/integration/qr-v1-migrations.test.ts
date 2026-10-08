import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { saveMerchantSetup, publishMerchantSetup, readMerchantSetup } from '../../backend/loyalty/merchant-setup.js';
import { createAnonymousCard, existingAnonymousCard, publicProgram, presentAnonymousCard, generateRecovery, recoverAnonymousCard, newEnrollmentNonce } from '../../backend/loyalty/anonymous-cards.js';

const migration = (name: string) =>
  readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');

describe('PostgreSQL executable migration validation — Taply QR V1', () => {
  it('applies all new migrations, backfills safely, provisions new merchants, enforces tenant policies', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role anon nologin;
        create role authenticated nologin;
        create role taply_owner nologin;
        create role taply_app login;
        create schema taply;
        grant usage on schema taply to taply_app;

        create table taply.merchants (
          id uuid primary key default gen_random_uuid(), name text not null,
          status text default 'active'
        );
        create table taply.loyalty_programs (
          id uuid primary key default gen_random_uuid(),
          merchant_id uuid not null,
          name text not null default 'Fidélité',
          status text not null default 'active',
          created_at timestamptz not null default now(),
          unique(id,merchant_id)
        );
        create table taply.locations (
          id uuid primary key default gen_random_uuid(),
          merchant_id uuid not null,name text not null,slug text not null,
          status text not null default 'active',
          unique(merchant_id,slug),unique(id,merchant_id)
        );
        create table taply.public_enrollment_links (
          id uuid primary key default gen_random_uuid(),
          public_token text not null unique,
          merchant_id uuid not null,location_id uuid not null,program_id uuid not null,
          status text not null default 'active',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        create table taply.program_rule_versions (
          id uuid primary key default gen_random_uuid(),
          merchant_id uuid not null,program_id uuid not null,version_no integer not null,
          rules jsonb not null,is_active boolean not null default false,
          created_at timestamptz not null default now()
        );
        create table taply.customers (
          id uuid primary key default gen_random_uuid(),
          merchant_id uuid not null
        );
        create table taply.memberships (
          id uuid primary key default gen_random_uuid(),
          merchant_id uuid not null,program_id uuid not null,
          customer_id uuid not null,current_rule_version_id uuid not null,
          created_at timestamptz not null default now(),status text default 'active',
          unique(id,merchant_id)
        );
        create table taply.membership_states (
          membership_id uuid primary key,merchant_id uuid not null,
          visit_count integer not null default 0,
          reward_pending boolean not null default false,
          cycle_number integer not null default 1
        );
        create table taply.wallet_qr_tokens (
          id uuid primary key default gen_random_uuid(),
          membership_id uuid not null,merchant_id uuid not null,
          token_hash text not null,revoked_at timestamptz,
          unique(token_hash)
        );

        grant select on taply.merchants,taply.loyalty_programs,
          taply.public_enrollment_links,taply.program_rule_versions to taply_app;
        grant update(status) on taply.loyalty_programs to taply_app;
        grant update(is_active) on taply.program_rule_versions to taply_app;
        grant insert on taply.program_rule_versions to taply_app;
        grant select,insert on taply.customers,taply.memberships,taply.membership_states,
          taply.wallet_qr_tokens to taply_app;
        grant update(revoked_at) on taply.wallet_qr_tokens to taply_app;
        grant update(visit_count) on taply.membership_states to taply_app;
      `);
      const m1='11111111-1111-4111-8111-111111111111';
      const m2='22222222-2222-4222-8222-222222222222';
      const p1='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const p2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await db.query('insert into taply.merchants(id,name) values($1,$2)',[m1,'Café Un']);
      await db.query('insert into taply.merchants(id,name) values($1,$2)',[m2,'Café Deux']);
      await db.query('insert into taply.loyalty_programs(id,merchant_id) values($1,$2)',[p1,m1]);
      await db.query(`insert into taply.program_rule_versions
        (id,merchant_id,program_id,version_no,rules,is_active)
        values($1,$2,$3,1,$4::jsonb,true)`,
        ['33333333-3333-4333-8333-333333333333',m1,p1,JSON.stringify({threshold:5})]);
      for (const name of [
        '20261008100010_program_publications.sql',
        '20261008100011_program_enrollment_links.sql',
        '20261008100012_anonymous_card_sessions.sql',
        '20261008100013_anonymous_enrollment_idempotency.sql',
      ]) await db.exec(migration(name));

      const first = await db.query<{ public_token:string;status:string }>(
        'select public_token,status from taply.public_enrollment_links where merchant_id=$1',[m1]);
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]!.public_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(first.rows[0]!.status).toBe('inactive');

      // Newly created programs trigger QR + primary location automatically.
      await db.query('insert into taply.loyalty_programs(id,merchant_id) values($1,$2)',[p2,m2]);
      await db.query(`insert into taply.program_rule_versions
        (id,merchant_id,program_id,version_no,rules,is_active)
        values($1,$2,$3,1,$4::jsonb,true)`,
        ['44444444-4444-4444-8444-444444444444',m2,p2,JSON.stringify({threshold:5})]);
      const second=await db.query<{ public_token:string;status:string }>(
        'select public_token,status from taply.public_enrollment_links where merchant_id=$1',[m2]);
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]!.public_token).not.toBe(first.rows[0]!.public_token);
      expect(second.rows[0]!.status).toBe('inactive');
      const locs=await db.query<{ n:number }>('select count(*)::integer as n from taply.locations');
      expect(locs.rows[0]!.n).toBe(2);

      // Unpublished content cannot claim a reward.
      await expect(db.query(`insert into taply.program_publications
        (program_id,merchant_id,published_at) values($1,$2,now())`,[p1,m1])).rejects.toThrow();

      // Check that valid owner insert works under verified RLS context.
      await db.exec('begin');
      await db.exec("set local role taply_app");
      await db.query("select set_config('app.merchant_id',$1,true)",[m1]);
      await db.query(`insert into taply.program_publications
        (program_id,merchant_id,reward_title,reward_terms) values($1,$2,$3,$4)`,
        [p1,m1,'Un café offert','Après 7 passages']);
      const visible=await db.query<{program_id:string}>('select program_id from taply.program_publications');
      expect(visible.rows).toHaveLength(1);
      const foreign=await db.query<{program_id:string}>('select program_id from taply.program_publications where merchant_id=$1',[m2]);
      expect(foreign.rows).toHaveLength(0);
      await db.exec('rollback');

      // Auth roles cannot access tables without the tenant RLS setting.
      await db.exec('begin');
      await db.exec('set local role taply_app');
      const none=await db.query('select program_id from taply.program_publications');
      expect(none.rows).toHaveLength(0);
      await db.exec('rollback');

      // Full backend service execution under tenant RLS, against real SQL.
      await db.exec('begin');
      await db.exec('set local role taply_app');
      await db.query("select set_config('app.merchant_id',$1,true)",[m1]);
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          const result = await db.query(sql, params);
          return { rows:result.rows, rowCount:result.affectedRows ?? 0 };
        },
      } as unknown as PoolClient;
      const principal = { role:'owner',merchantId:m1,
        authUserId:'auth-test',merchantUserId:'owner-test',sessionId:'session-test' } as const;
      const saved = await saveMerchantSetup(client,principal,{
        threshold:7,rewardTitle:'Un café offert',rewardTerms:'Après 7 passages éligibles',
        cardColor:'#10241A',textColor:'#FFFFFF',
      });
      expect(saved).toBe('updated');
      const publication = await publishMerchantSetup(client,principal);
      expect(publication).toBe('published');
      const setup = await readMerchantSetup(client,principal,'https://taply.example/');
      expect(setup?.published).toBe(true);
      expect(setup?.enrollmentUrl).toContain('join.html?code=');

      const details = await publicProgram(client,m1,p1);
      expect(details).toMatchObject({merchantName:'Café Un',threshold:7,
        rewardTitle:'Un café offert'});

      const nonce = newEnrollmentNonce();
      const enrolled = await createAnonymousCard(client,m1,p1,undefined,nonce);
      expect(enrolled.status).toBe('created');
      if(enrolled.status!=='created')throw new Error('Expected created anonymous membership');
      expect(enrolled.card.visits).toBe(0);
      expect(enrolled.card.rewardPending).toBe(false);
      const session = enrolled.session;
      expect(session).toBeTruthy();

      const reopened = await existingAnonymousCard(client,m1,p1,session);
      expect(reopened?.membershipId).toBe(enrolled.card.membershipId);
      expect(reopened?.visits).toBe(0);
      const reused = await createAnonymousCard(client,m1,p1,session,nonce);
      expect(reused.status).toBe('existing');
      const parallel = await createAnonymousCard(client,m1,p1,undefined,nonce);
      expect(parallel.status).toBe('existing');
      if (parallel.status === 'existing') expect(parallel.card.membershipId).toBe(enrolled.card.membershipId);
      const people = await db.query('select id from taply.customers');
      expect(people.rows).toHaveLength(1);
      const visits = await db.query("select count(*)::integer as n from taply.membership_states where visit_count>0");
      expect(visits.rows[0]).toEqual({n:0});

      const display = await presentAnonymousCard(client,m1,p1,session);
      expect(display?.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const recovery = await generateRecovery(client,m1,p1,session);
      expect(recovery).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/);
      const restored = await recoverAnonymousCard(client,m1,p1,recovery!);
      expect(restored?.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(restored?.session).not.toBe(session);
      expect(await existingAnonymousCard(client,m1,p1,session)).toBeUndefined();
      expect(await existingAnonymousCard(client,m1,p1,restored?.session)).toBeDefined();
      expect(await recoverAnonymousCard(client,m1,p1,recovery!)).toBeUndefined();
      await db.exec('rollback');
    } finally {
      await db.close();
    }
  }, 25_000);
});
