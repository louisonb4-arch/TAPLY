/**
 * Certification PostgreSQL RÉEL (pas mocks) du coeur fidélité Taply.
 *
 * Usage EXCLUSIVEMENT sur un cluster PostgreSQL 17 JETABLE:
 *   TAPLY_PG_CERT_ACK=isolated-postgres-cluster
 *   POSTGRES_CERT_URL=postgresql://postgres:<secret>@127.0.0.1:54329/taply_cert
 *   npm run db:loyalty:cert
 *
 * Ne JAMAIS pointer vers Supabase, staging ou la production.
 * Un garde vérifie hôte/port/base/user et l'absence de schémas et rôles
 * Taply AVANT tout DDL. Le cluster complet doit être jetable : les migrations
 * créent des RÔLES PostgreSQL (globaux au cluster).
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { withTenantTx } from '../../backend/db/tenant-context.ts';
import { creditVisit } from '../../backend/loyalty/credit.ts';
import { redeemReward } from '../../backend/loyalty/redeem.ts';
import { createStaffDevicePairing, activateStaffDevice, authorizeStaffAction } from '../../backend/auth/staff-device.ts';
import { registerCustomer, getLoyaltyCard, merchantOverview, updateMerchantProgram } from '../../backend/loyalty/operations.ts';
import { scanWalletQrAndCredit } from '../../backend/loyalty/scan.ts';

const ACK = 'isolated-postgres-cluster';
const DB_NAME = 'taply_cert';
const PORT = '54329';
let admin;
let app;
let passed = 0;

function config() {
  assert.equal(process.env.TAPLY_PG_CERT_ACK, ACK,
    'Refus: confirmer explicitement que le cluster PostgreSQL est jetable');
  const raw = process.env.POSTGRES_CERT_URL;
  assert.ok(raw, 'POSTGRES_CERT_URL requis (base de test locale isolée)');
  const url = new URL(raw);
  assert.equal(url.protocol, 'postgresql:');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'PostgreSQL distant INTERDIT');
  assert.equal(url.port, PORT, 'Port dédié 54329 obligatoire');
  assert.equal(url.pathname, '/' + DB_NAME, 'Base taply_cert obligatoire');
  assert.equal(decodeURIComponent(url.username), 'postgres', 'Rôle admin de test postgres requis');
  assert.equal(url.search, '', 'Paramètres URL non autorisés');
  return {
    host: '127.0.0.1',
    port: Number(PORT),
    database: DB_NAME,
    user: 'postgres',
    password: decodeURIComponent(url.password),
    ssl: false,
    connectionTimeoutMillis: 3000,
  };
}

async function verifyFreshDisposableDatabase(pool) {
  const identity = await pool.query(
    'select current_database() as db, current_user as usr, current_setting(\'server_version_num\')::integer as ver',
  );
  assert.equal(identity.rows[0]?.db, DB_NAME);
  assert.equal(identity.rows[0]?.usr, 'postgres');
  assert.ok(identity.rows[0].ver >= 170000 && identity.rows[0].ver < 180000,
    'Certification prévue pour PostgreSQL 17');
  const dirty = await pool.query(`
    select
      (select count(*)::integer from pg_namespace where nspname in ('taply','auth')) as schemas,
      (select count(*)::integer from pg_roles where rolname in
        ('taply_owner','taply_app','anon','authenticated','service_role')) as roles,
      (select count(*)::integer from pg_tables where schemaname='public') as public_tables
  `);
  assert.deepEqual(dirty.rows[0], { schemas: 0, roles: 0, public_tables: 0 },
    'Base/cluster non vierge: certification INTERDITE, aucune mutation');
}

async function migrate(pool) {
  const path = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const files = (await readdir(path)).filter((f) => /^20\d{12}_.+\.sql$/.test(f)).sort();
  assert.ok(files.length >= 16, 'Migrations attendues manquantes');

  const client = await pool.connect();
  try {
    await client.query('begin');
    // Le vrai Supabase possède ces rôles/schéma : bootstrap UNIQUEMENT CI jetable.
    await client.query('create role anon nologin');
    await client.query('create role authenticated nologin');
    await client.query('create role service_role nologin');
    await client.query('create schema auth');
    await client.query('create table auth.users (id uuid primary key)');
    for (const file of files) {
      const sql = await readFile(new URL('../../supabase/migrations/' + file, import.meta.url), 'utf8');
      // Texte SQL complet: surtout PAS de split(';') à cause des DO $$ ... $$.
      await client.query(sql);
      console.log('MIGRATION OK', file);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name);
    throw error;
  }
}

async function seed(pool, slug) {
  const f = {
    merchant: randomUUID(), program: randomUUID(), rule: randomUUID(),
    customer: randomUUID(), membership: randomUUID(), slug,
  };
  await pool.query('insert into taply.merchants (id, name, slug) values ($1, $2, $3)',
    [f.merchant, slug, slug]);
  await pool.query('insert into taply.loyalty_programs (id, merchant_id, name) values ($1, $2, $3)',
    [f.program, f.merchant, 'Carte de fidélité test']);
  await pool.query(`insert into taply.program_rule_versions
    (id, merchant_id, program_id, version_no, rules, is_active)
    values ($1, $2, $3, 1, $4::jsonb, true)`,
    [f.rule, f.merchant, f.program, JSON.stringify({ threshold: 3 })]);
  await pool.query('insert into taply.customers (id, merchant_id) values ($1, $2)',
    [f.customer, f.merchant]);
  await pool.query(`insert into taply.memberships
    (id, merchant_id, customer_id, program_id, current_rule_version_id)
    values ($1, $2, $3, $4, $5)`,
    [f.membership, f.merchant, f.customer, f.program, f.rule]);
  await pool.query('insert into taply.membership_states (membership_id, merchant_id) values ($1, $2)',
    [f.membership, f.merchant]);
  f.principal = {
    sessionId: randomUUID(), merchantId: f.merchant,
    merchantUserId: randomUUID(), authUserId: randomUUID(), role: 'owner',
  };
  return f;
}

const key = () => randomUUID();
const credit = (f, idempotencyKey = key()) =>
  withTenantTx(app, f.merchant, (client) =>
    creditVisit(client, f.principal, {
      membershipId: f.membership, source: 'QR_EMPLOYEE', idempotencyKey,
    }));

const redeem = (f, expectedCycleNumber, idempotencyKey = key()) =>
  withTenantTx(app, f.merchant, (client) =>
    redeemReward(client, f.principal, {
      membershipId: f.membership, expectedCycleNumber, idempotencyKey,
    }));

async function state(f) {
  const rows = await admin.query('select * from taply.membership_states where membership_id=$1',
    [f.membership]);
  return rows.rows[0];
}

async function count(table, f) {
  const result = await admin.query('select count(*)::integer as n from taply.' + table +
    ' where membership_id=$1', [f.membership]);
  return result.rows[0].n;
}

async function certify() {
  const db = config();
  admin = new Pool({ ...db, max: 2 });
  await verifyFreshDisposableDatabase(admin);
  await migrate(admin);

  // Mot de passe aléatoire qui n'existe QUE dans ce cluster jetable.
  const testPassword = randomBytes(32).toString('hex');
  await admin.query("alter role taply_app password '" + testPassword + "'");
  app = new Pool({ ...db, user: 'taply_app', password: testPassword, max: 6 });

  await test('Le runtime se connecte avec le rôle non privilégié taply_app', async () => {
    const result = await app.query('select current_user as name');
    assert.equal(result.rows[0].name, 'taply_app');
    const role = await admin.query(`select rolsuper, rolbypassrls, rolcreaterole
      from pg_roles where rolname = 'taply_app'`);
    assert.deepEqual(role.rows[0], {
      rolsuper: false, rolbypassrls: false, rolcreaterole: false,
    });
  });

  await test('FORCE RLS réellement activé sur les tables de fidélité', async () => {
    const result = await admin.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='taply' and c.relname=any($1::text[])`,
      [['membership_states', 'visit_ledger', 'redemption_ledger', 'wallet_qr_tokens']]);
    assert.equal(result.rowCount, 4);
    for (const row of result.rows) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.relforcerowsecurity, true, row.relname);
    }
  });

  await test('GRANT: taply_app ne peut ni effacer le ledger ni antidater les entrées', async () => {
    for (const table of ['visit_ledger', 'redemption_ledger']) {
      const rights = await admin.query(`select
        has_table_privilege('taply_app', $1, 'UPDATE') as upd,
        has_table_privilege('taply_app', $1, 'DELETE') as del,
        has_column_privilege('taply_app', $1, $2, 'INSERT') as forge`,
      ['taply.' + table, table === 'visit_ledger' ? 'credited_at' : 'redeemed_at']);
      assert.deepEqual(rights.rows[0], { upd: false, del: false, forge: false }, table);
    }
  });

  const A = await seed(admin, 'cert-a-' + randomBytes(5).toString('hex'));
  const B = await seed(admin, 'cert-b-' + randomBytes(5).toString('hex'));

  await test('RLS: sans merchant_id, aucune membership visible', async () => {
    const result = await app.query('select count(*)::integer as n from taply.membership_states');
    assert.equal(result.rows[0].n, 0);
  });

  await test('RLS: marchand B ne peut lire/modifier la carte du marchand A', async () => {
    await withTenantTx(app, B.merchant, async (client) => {
      const rows = await client.query('select * from taply.membership_states where membership_id=$1',
        [A.membership]);
      assert.equal(rows.rowCount, 0);
      const update = await client.query(`update taply.membership_states
        set visit_count=9 where membership_id=$1`, [A.membership]);
      assert.equal(update.rowCount, 0);
    });
    assert.equal((await state(A)).visit_count, 0);
  });

  await test('Transaction-local RLS: aucun merchant_id ne fuit après COMMIT', async () => {
    await withTenantTx(app, A.merchant, async (client) => {
      const result = await client.query('select count(*)::integer as n from taply.membership_states');
      assert.equal(result.rows[0].n, 1);
    });
    const result = await app.query('select count(*)::integer as n from taply.membership_states');
    assert.equal(result.rows[0].n, 0);
  });

  const firstKey = key();
  await test('Vrai crédit SQL, rejoué avec même clé sans second passage', async () => {
    const first = await credit(A, firstKey);
    assert.equal(first.credited, true);
    assert.equal(first.visitCount, 1);
    const replay = await credit(A, firstKey);
    assert.deepEqual(replay, first);
    assert.equal((await state(A)).visit_count, 1);
    assert.equal(await count('visit_ledger', A), 1);
  });

  await test('Cooldown réel: une autre clé ne contourne pas les deux heures', async () => {
    const denied = await credit(A);
    assert.equal(denied.credited, false);
    assert.equal(denied.reason.kind, 'cooldown_active');
    assert.equal(await count('visit_ledger', A), 1);
  });

  await test('Seuil 3: cadeau débloqué puis passages verrouillés', async () => {
    for (const expected of [2, 3]) {
      // Intervention fixture ADMIN sur base jetable pour simuler 3 heures.
      await admin.query(`update taply.membership_states
        set last_credited_at = now() - interval '3 hours' where membership_id=$1`,
        [A.membership]);
      const result = await credit(A);
      assert.equal(result.credited, true);
      assert.equal(result.visitCount, expected);
      assert.equal(result.rewardUnlocked, expected === 3);
    }
    const denied = await credit(A);
    assert.equal(denied.credited, false);
    assert.equal(denied.reason.kind, 'reward_pending');
    assert.equal(await count('visit_ledger', A), 3);
  });

  let ruleV2;
  await test('Nouvelle règle du prochain cycle, l\'ancienne restant épinglée', async () => {
    ruleV2 = randomUUID();
    await admin.query('update taply.program_rule_versions set is_active=false where id=$1',
      [A.rule]);
    await admin.query(`insert into taply.program_rule_versions
      (id, merchant_id, program_id, version_no, rules, is_active)
      values ($1, $2, $3, 2, $4::jsonb, true)`,
      [ruleV2, A.merchant, A.program, JSON.stringify({ threshold: 5 })]);
    const pinned = await admin.query('select current_rule_version_id from taply.memberships where id=$1',
      [A.membership]);
    assert.equal(pinned.rows[0].current_rule_version_id, A.rule);
  });

  const redeemKey = key();
  await test('Remise atomique: un seul journal, cycle +1, cooldown conservé', async () => {
    const oldState = await state(A);
    const result = await redeem(A, 1, redeemKey);
    assert.equal(result.redeemed, true);
    assert.equal(result.completedCycle, 1);
    assert.equal(result.newCycleNumber, 2);
    assert.equal(result.nextThreshold, 5);
    const newState = await state(A);
    assert.equal(newState.visit_count, 0);
    assert.equal(newState.reward_pending, false);
    assert.equal(newState.cycle_number, 2);
    assert.equal(newState.last_credited_at.toISOString(),
      oldState.last_credited_at.toISOString());
    assert.equal(await count('redemption_ledger', A), 1);
    const membership = await admin.query('select current_rule_version_id from taply.memberships where id=$1',
      [A.membership]);
    assert.equal(membership.rows[0].current_rule_version_id, ruleV2);
  });

  await test('Même clé de remise rejouée: résultat identique, aucun double cadeau', async () => {
    const original = await redeem(A, 1, redeemKey);
    assert.equal(original.redeemed, true);
    const wrongKey = await redeem(A, 1);
    assert.equal(wrongKey.redeemed, false);
    assert.equal(wrongKey.reason.kind, 'cycle_mismatch');
    assert.equal(await count('redemption_ledger', A), 1);
  });

  await test('Concurrence réelle: deux crédits simultanés = un seul passage', async () => {
    await admin.query(`update taply.membership_states
      set last_credited_at = now() - interval '3 hours' where membership_id=$1`,
      [A.membership]);
    const results = await Promise.all([credit(A), credit(A)]);
    assert.equal(results.filter((r) => r.credited).length, 1, JSON.stringify(results));
    assert.equal((await state(A)).visit_count, 1);
    assert.equal(await count('visit_ledger', A), 4);
  });

  await test('Concurrence réelle: deux remises simultanées = un seul cadeau', async () => {
    // Mise en état par administrateur de fixture, uniquement pour isoler la course.
    await admin.query(`update taply.membership_states
      set visit_count=5, reward_pending=true, last_credited_at=now() - interval '3 hours'
      where membership_id=$1`, [A.membership]);
    const results = await Promise.all([redeem(A, 2), redeem(A, 2)]);
    assert.equal(results.filter((r) => r.redeemed).length, 1, JSON.stringify(results));
    assert.equal(await count('redemption_ledger', A), 2);
    assert.equal((await state(A)).cycle_number, 3);
  });

  await test('ROLLBACK réel: aucun état, journal ni claim idempotent persisté', async () => {
    const rollbackKey = key();
    await assert.rejects(() => withTenantTx(app, B.merchant, async (client) => {
      const result = await creditVisit(client, B.principal, {
        membershipId: B.membership, source: 'QR_EMPLOYEE', idempotencyKey: rollbackKey,
      });
      assert.equal(result.credited, true);
      throw new Error('certification rollback volontaire');
    }), /certification rollback volontaire/);
    assert.equal((await state(B)).visit_count, 0);
    assert.equal(await count('visit_ledger', B), 0);
    const claims = await admin.query(`select count(*)::integer as n
      from taply.idempotency_requests where merchant_id=$1 and idempotency_key=$2`,
      [B.merchant, rollbackKey]);
    assert.equal(claims.rows[0].n, 0);
  });

  await test('Immutabilité SQL: DELETE et UPDATE ledger réellement refusés', async () => {
    await assert.rejects(
      () => withTenantTx(app, A.merchant, (client) =>
        client.query('delete from taply.redemption_ledger where membership_id=$1', [A.membership])),
      (e) => e.code === '42501',
    );
    await assert.rejects(
      () => withTenantTx(app, A.merchant, (client) =>
        client.query(`update taply.visit_ledger set credited_at=now()
          where membership_id=$1`, [A.membership])),
      (e) => e.code === '42501',
    );
  });

  await test('Appareils: approbation owner, activation staff, PIN, blocage et révocation', async () => {
    const staff = {
      ...A.principal,
      merchantUserId: randomUUID(),
      authUserId: randomUUID(),
      role: 'staff',
    };
    await admin.query('insert into auth.users(id) values($1),($2)', [A.principal.authUserId, staff.authUserId]);
    await admin.query(`insert into taply.merchant_users
      (id, merchant_id, auth_user_id, role) values ($1, $3, $2, 'owner'), ($4, $3, $5, 'staff')`,
      [A.principal.merchantUserId, A.principal.authUserId, A.merchant,
        staff.merchantUserId, staff.authUserId]);
    const unauthorizedPairing = await withTenantTx(app, A.merchant,
      (client) => createStaffDevicePairing(client, staff, staff.merchantUserId));
    assert.equal(unauthorizedPairing, undefined);
    const invite = await withTenantTx(app, A.merchant,
      (client) => createStaffDevicePairing(client, A.principal, staff.merchantUserId));
    assert.match(invite, /^[A-Za-z0-9_-]{43}$/);
    const mismatched = await withTenantTx(app, A.merchant,
      (client) => activateStaffDevice(client, A.principal, invite, '12345678'));
    assert.equal(mismatched, undefined);
    const device = await withTenantTx(app, A.merchant,
      (client) => activateStaffDevice(client, staff, invite, '12345678'));
    assert.match(device?.rawDeviceToken, /^[A-Za-z0-9_-]{43}$/);
    const replay = await withTenantTx(app, A.merchant,
      (client) => activateStaffDevice(client, staff, invite, '12345678'));
    assert.equal(replay, undefined);

    const allow = (principal, pin) => withTenantTx(app, principal.merchantId,
      (client) => authorizeStaffAction(client, principal, device.rawDeviceToken, pin));
    assert.equal(await allow(staff, '12345678'), true);
    assert.equal(await allow(B.principal, '12345678'), false);
    for (let i = 0; i < 5; i++) assert.equal(await allow(staff, '87654321'), false);
    assert.equal(await allow(staff, '12345678'), false, 'PIN exact refuse pendant lockout');
    const locks = await admin.query(
      'select failed_attempts, locked_until from taply.staff_devices where id=$1',
      [device.deviceId],
    );
    assert.equal(locks.rows[0].failed_attempts, 5);
    assert.ok(locks.rows[0].locked_until !== null);
    await admin.query(`update taply.staff_devices
      set locked_until=now() - interval '1 second' where id=$1`, [device.deviceId]);
    assert.equal(await allow(staff, '12345678'), true);
    const reset = await admin.query(
      'select failed_attempts from taply.staff_devices where id=$1', [device.deviceId],
    );
    assert.equal(reset.rows[0].failed_attempts, 0);
    await admin.query('update taply.staff_devices set revoked_at=now() where id=$1', [device.deviceId]);
    assert.equal(await allow(staff, '12345678'), false, 'revoked device must never authorize');
  });

  await test('Appareils: PIN pas en clair dans la base', async () => {
    const row = await admin.query('select pin_salt,pin_verifier from taply.staff_devices limit 1');
    assert.match(row.rows[0].pin_salt, /^[0-9a-f]{32}$/);
    assert.match(row.rows[0].pin_verifier, /^[0-9a-f]{128}$/);
    assert.ok(!row.rows[0].pin_verifier.includes('12345678'));
  });

  await test('Création carte client: consentement, QR opaque, aucun crédit automatique', async () => {
    const key = randomUUID();
    const input = {
      firstName: 'Élodie',
      programId: A.program,
      idempotencyKey: key,
      privacyAccepted: true,
    };
    const first = await withTenantTx(app, A.merchant,
      (client) => registerCustomer(client, A.principal, input));
    assert.ok(first?.membershipId);
    assert.match(first?.qrToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await count('visit_ledger', { membership: first.membershipId }), 0);
    const state = await admin.query(
      'select visit_count, reward_pending from taply.membership_states where membership_id=$1',
      [first.membershipId],
    );
    assert.equal(state.rows[0].visit_count, 0);
    assert.equal(state.rows[0].reward_pending, false);
    const profile = await admin.query(
      'select first_name from taply.customer_profiles where customer_id=$1',
      [first.customerId],
    );
    assert.equal(profile.rows[0].first_name, 'Élodie');

    const replay = await withTenantTx(app, A.merchant,
      (client) => registerCustomer(client, A.principal, input));
    assert.equal(replay.membershipId, first.membershipId);
    assert.equal(replay.qrToken, undefined, 'Un jeton QR brut ne doit PAS être stocké en DB');
    const textCheck = await admin.query(`select response::text as response
      from taply.idempotency_requests where merchant_id=$1 and idempotency_key=$2`,
      [A.merchant, key]);
    assert.ok(!textCheck.rows[0].response.includes(first.qrToken));
    const otherTenant = await withTenantTx(app, B.merchant,
      (client) => registerCustomer(client, B.principal, input));
    assert.equal(otherTenant, undefined);
    const initial = await withTenantTx(app, A.merchant,
      (client) => getLoyaltyCard(client, A.principal, first.qrToken));
    assert.equal(initial.firstName, 'Élodie');
    assert.equal(initial.visitCount, 0);
    assert.equal(initial.threshold, 5);
    const denied = await withTenantTx(app, B.merchant,
      (client) => getLoyaltyCard(client, B.principal, first.qrToken));
    assert.equal(denied, undefined);

    const credited = await withTenantTx(app, A.merchant, (client) =>
      scanWalletQrAndCredit(client, A.principal, first.qrToken, randomUUID()));
    assert.equal(credited.credited, true);
    assert.equal(credited.visitCount, 1);
    assert.equal(await count('visit_ledger', { membership: first.membershipId }), 1);
  });

  await test('Dashboard et préférences: propriétaire, notifications OFF par défaut, programme en pause', async () => {
    const initial = await withTenantTx(app, A.merchant,
      (client) => merchantOverview(client, A.principal));
    assert.equal(initial.length, 1);
    assert.equal(initial[0].threshold, 5);
    assert.equal(initial[0].notificationsEnabled, false);
    assert.equal(initial[0].totalMembers, 2);

    const staffFake = { ...A.principal, role: 'staff' };
    const denied = await withTenantTx(app, A.merchant, (client) =>
      updateMerchantProgram(client, staffFake, {
        programId: A.program, status: 'paused', notificationsEnabled: true,
      }));
    assert.equal(denied.ok, false);
    const paused = await withTenantTx(app, A.merchant, (client) =>
      updateMerchantProgram(client, A.principal, {
        programId: A.program, status: 'paused', notificationsEnabled: true,
      }));
    assert.equal(paused.ok, true);
    const overview = await withTenantTx(app, A.merchant,
      (client) => merchantOverview(client, A.principal));
    assert.equal(overview[0].status, 'paused');
    assert.equal(overview[0].notificationsEnabled, true);
    const reset = await withTenantTx(app, A.merchant, (client) =>
      updateMerchantProgram(client, A.principal, {
        programId: A.program, status: 'active', notificationsEnabled: false,
      }));
    assert.equal(reset.ok, true);
  });

  await test('Changement de seuil: 30 jours et version épinglée au cycle', async () => {
    const tooSoon = await withTenantTx(app, A.merchant, (client) =>
      updateMerchantProgram(client, A.principal, {
        programId: A.program, status: 'active', notificationsEnabled: false, threshold: 7,
      }));
    assert.deepEqual(tooSoon, { ok: false, reason: 'change_too_soon' });
    await admin.query(`update taply.program_rule_versions
      set created_at=now() - interval '31 days'
      where id=(select id from taply.program_rule_versions
        where merchant_id=$1 and program_id=$2 and is_active=true)`,
      [A.merchant, A.program]);
    const changed = await withTenantTx(app, A.merchant, (client) =>
      updateMerchantProgram(client, A.principal, {
        programId: A.program, status: 'active', notificationsEnabled: false, threshold: 7,
      }));
    assert.deepEqual(changed, { ok: true, nextThreshold: 7 });
    const current = await withTenantTx(app, A.merchant,
      (client) => merchantOverview(client, A.principal));
    assert.equal(current[0].threshold, 7);
    const previouslyPinned = await admin.query(`select rules->>'threshold' as threshold
      from taply.program_rule_versions v join taply.memberships m
       on m.current_rule_version_id=v.id where m.id=$1`, [A.membership]);
    assert.equal(previouslyPinned.rows[0].threshold, '5');
    const cross = await withTenantTx(app, B.merchant, (client) =>
      updateMerchantProgram(client, B.principal, {
        programId: A.program, status: 'paused', notificationsEnabled: true,
      }));
    assert.equal(cross.ok, false);
  });

  console.log('CERTIFICATION PG17 OK:', passed, 'vérifications dynamiques');
}

try {
  await certify();
} catch (error) {
  console.error('CERTIFICATION PG17 ÉCHOUÉE:', error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  if (app) await app.end();
  if (admin) await admin.end();
}
