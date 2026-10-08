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
import { rotateWalletQr } from '../../backend/loyalty/rotation.ts';
import { resolveWalletQrToken } from '../../backend/loyalty/qr-token.ts';
import { createApp } from '../../backend/http/app.ts';
import { loadConfig } from '../../backend/core/config.ts';
import { createLogger } from '../../backend/core/logger.ts';
import { generateSessionToken, hashSessionToken } from '../../backend/auth/token.ts';
import { preparePublicEnrollment, confirmPublicEnrollment } from '../../backend/loyalty/enrollment.ts';
import { securityOverview } from '../../backend/loyalty/security-overview.ts';
import { merchantCustomers } from '../../backend/loyalty/dashboard-read.ts';

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
  await pool.query('insert into auth.users(id) values($1)', [f.principal.authUserId]);
  await pool.query(`insert into taply.merchant_users
    (id, merchant_id, auth_user_id, role) values($1,$2,$3,'owner')`,
    [f.principal.merchantUserId, f.merchant, f.principal.authUserId]);
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

  await test('Audit anti-fraude: employé exact sur passages/remises, FK inter-commerces', async () => {
    const visit = await admin.query(`select performed_by from taply.visit_ledger
      where membership_id=$1 order by credited_at limit 1`, [A.membership]);
    assert.equal(visit.rows[0].performed_by, A.principal.merchantUserId);
    const gift = await admin.query(`select performed_by from taply.redemption_ledger
      where membership_id=$1 order by redeemed_at limit 1`, [A.membership]);
    assert.equal(gift.rows[0].performed_by, A.principal.merchantUserId);
    await assert.rejects(() => withTenantTx(app, A.merchant, (client) =>
      client.query(`insert into taply.visit_ledger
        (membership_id,merchant_id,cycle_number,source,idempotency_key,performed_by)
        values($1,$2,999,'QR_EMPLOYEE',$3,$4)`,
        [A.membership,A.merchant,randomUUID(),B.principal.merchantUserId])),
    (err) => err.code === '23503');
    await assert.rejects(() => withTenantTx(app, A.merchant, (client) =>
      client.query(`insert into taply.visit_ledger
        (membership_id,merchant_id,cycle_number,source,idempotency_key)
        values($1,$2,999,'QR_EMPLOYEE',$3)`,
        [A.membership,A.merchant,randomUUID()])),
    (err) => err.code === '23514');
  });

  await test('Appareils: approbation owner, activation staff, PIN, blocage et révocation', async () => {
    const staff = {
      ...A.principal,
      merchantUserId: randomUUID(),
      authUserId: randomUUID(),
      role: 'staff',
    };
    await admin.query('insert into auth.users(id) values($1)', [staff.authUserId]);
    await admin.query(`insert into taply.merchant_users
      (id, merchant_id, auth_user_id, role) values ($1, $2, $3, 'staff')`,
      [staff.merchantUserId, A.merchant, staff.authUserId]);
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

  await test('Remplacement QR: ancien révoqué, nouveau actif, replay sans secret, audit immuable', async () => {
    const issue = await withTenantTx(app, A.merchant, (client) =>
      rotateWalletQr(client, A.principal, { membershipId: A.membership, idempotencyKey: randomUUID() }));
    assert.equal(issue.rotated, true);
    assert.match(issue.qrToken, /^[A-Za-z0-9_-]{43}$/);
    const before = await withTenantTx(app, A.merchant,
      (client) => resolveWalletQrToken(client, A.principal, issue.qrToken));
    assert.equal(before, A.membership);

    const key2 = randomUUID();
    const next = await withTenantTx(app, A.merchant, (client) =>
      rotateWalletQr(client, A.principal, { membershipId: A.membership, idempotencyKey: key2 }));
    assert.equal(next.rotated, true);
    assert.notEqual(next.qrToken, issue.qrToken);
    const revoked = await withTenantTx(app, A.merchant,
      (client) => resolveWalletQrToken(client, A.principal, issue.qrToken));
    assert.equal(revoked, undefined);
    const current = await withTenantTx(app, A.merchant,
      (client) => resolveWalletQrToken(client, A.principal, next.qrToken));
    assert.equal(current, A.membership);

    const replay = await withTenantTx(app, A.merchant, (client) =>
      rotateWalletQr(client, A.principal, { membershipId: A.membership, idempotencyKey: key2 }));
    assert.equal(replay.membershipId, A.membership);
    assert.equal(replay.qrToken, undefined, 'Ne stocke jamais le QR brut dans idempotency_requests');
    assert.equal(await count('wallet_qr_rotations', A), 2);
    const active = await admin.query(`select count(*)::integer as n from taply.wallet_qr_tokens
      where membership_id=$1 and revoked_at is null`, [A.membership]);
    assert.equal(active.rows[0].n, 1);
    const cross = await withTenantTx(app, B.merchant, (client) =>
      rotateWalletQr(client, B.principal,
        { membershipId: A.membership, idempotencyKey: randomUUID() }));
    assert.equal(cross, undefined);
    const access = await admin.query(`select has_table_privilege('taply_app',
      'taply.wallet_qr_rotations','DELETE') as can_delete`);
    assert.equal(access.rows[0].can_delete, false);
  });

  await test('QR public: 20 préparations maximum/10 min, sans créer de passage ni de carte', async () => {
    const location = randomUUID();
    const publicToken = randomBytes(20).toString('base64url');
    await admin.query(`insert into taply.locations
      (id,merchant_id,name,slug) values($1,$2,'Boutique test','comptoir')`,
      [location, B.merchant]);
    await admin.query(`insert into taply.public_enrollment_links
      (public_token,merchant_id,location_id,program_id) values($1,$2,$3,$4)`,
      [publicToken, B.merchant, location, B.program]);
    const attempts = await Promise.all(Array.from({ length: 25 }, () =>
      preparePublicEnrollment(app, {
        publicToken, firstName: 'Clara', privacyAccepted: true,
      })));
    assert.equal(attempts.filter(x => x.status === 'prepared').length, 20);
    assert.equal(attempts.filter(x => x.status === 'rate_limited').length, 5);
    assert.equal((await state(B)).visit_count, 0);
    assert.equal(await count('visit_ledger', B), 0);
    const cards = await admin.query(`select count(*)::integer as n
      from taply.wallet_qr_tokens where merchant_id=$1`, [B.merchant]);
    assert.equal(cards.rows[0].n, 0);
    const pending = attempts.find(x=>x.status==='prepared');
    const wrongShop = await withTenantTx(app, A.merchant,
      (client) => confirmPublicEnrollment(client,A.principal,
        { claimToken: pending.claimToken, idempotencyKey: randomUUID() }));
    assert.equal(wrongShop.status, 'not_found');
  });

  await test('HTTP E2E réel: cookie session + PIN + appareil + création + scan + cadeau', async () => {
    const ownerPairing = await withTenantTx(app, A.merchant,
      (client) => createStaffDevicePairing(client, A.principal, A.principal.merchantUserId));
    const ownerDevice = await withTenantTx(app, A.merchant,
      (client) => activateStaffDevice(client, A.principal, ownerPairing, '31415926'));
    assert.ok(ownerDevice?.rawDeviceToken);

    const rawSession = generateSessionToken();
    await admin.query(`insert into taply.merchant_sessions
       (merchant_id,merchant_user_id,auth_user_id,token_hash,idle_expires_at,absolute_expires_at)
       values($1,$2,$3,$4,now()+interval '2 hours',now()+interval '12 hours')`,
      [A.merchant, A.principal.merchantUserId, A.principal.authUserId,
        hashSessionToken(rawSession)]);
    const envKey = 'TAPLY_LOYALTY_PREVIEW';
    const old = process.env[envKey];
    process.env[envKey] = 'enabled';
    try {
      const ORIGIN = 'http://127.0.0.1:3000';
      const web = createApp({
        config: loadConfig({ APP_ENV: 'test', APP_ORIGIN: ORIGIN }),
        logger: createLogger({ level: 'error' }),
        dbPool: app,
      });
      const cookies = `taply_session=${rawSession}; taply_staff_device=${ownerDevice.rawDeviceToken}`;
      const post = async (path, body, override = {}) => {
        return web.request('/api/loyalty/' + path, {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookies,
            ...override },
          body: JSON.stringify(body),
        });
      };
      const invalidOrigin = await post('scan', {
        qrToken: 'fake', pin: '31415926',
        idempotencyKey: randomUUID(), purchaseConfirmed: true,
      }, { Origin: 'https://attacker.example' });
      assert.equal(invalidOrigin.status, 403);

      const whoami = await web.request('/api/loyalty/identity', {
        headers: { Cookie: cookies },
      });
      assert.equal(whoami.status, 200);
      assert.equal((await whoami.json()).merchantUserId, A.principal.merchantUserId);
      const merchant = await web.request('/api/loyalty/merchant', {
        headers: { Cookie: cookies },
      });
      assert.equal(merchant.status, 200);
      assert.match((await merchant.json()).name, /.+/);
      assert.equal((await web.request('/api/loyalty/merchant')).status, 401);
      const overview = await web.request('/api/loyalty/overview', {
        headers: { Cookie: cookies },
      });
      assert.equal(overview.status, 200);
      assert.equal((await overview.json()).programs[0].threshold, 7);

      const security = await web.request('/api/loyalty/security', {
        headers: { Cookie: cookies },
      });
      assert.equal(security.status, 200);
      const securityBody = await security.json();
      assert.ok(securityBody.devices.some(device => device.id === ownerDevice.deviceId));
      assert.ok(!JSON.stringify(securityBody).includes('pin_verifier'));
      const noAuthSecurity = await web.request('/api/loyalty/security');
      assert.equal(noAuthSecurity.status, 401);

      const reg = await post('customers/register', {
        firstName: 'Manon', programId: A.program,
        idempotencyKey: randomUUID(), privacyAccepted: true,
        customerPresent: true, pin: '31415926',
      });
      const registered = await reg.json();
      assert.equal(reg.status, 201);
      assert.match(registered.qrToken, /^[A-Za-z0-9_-]{43}$/);
      // Le QR brut n'est envoyé qu'une fois, dans la réponse confidentielle.
      // Verify staff route persisted the registration in the live customer list.
      const customersHTTP = await web.request('/api/loyalty/customers', {
        headers: { Cookie: cookies },
      });
      assert.equal(customersHTTP.status, 200);
      const customersJSON = await customersHTTP.json();
      assert.ok(customersJSON.customers.some(x => x.membershipId === registered.membershipId));
      assert.equal(customersJSON.limit, 50);
      const afterReg = await web.request('/api/loyalty/overview', {
        headers: { Cookie: cookies },
      });
      assert.equal((await afterReg.json()).programs[0].totalMembers, 3);

      // Le QR du présentoir n'est JAMAIS une carte de fidélité.
      const publicLocation = randomUUID();
      const posterToken = randomBytes(20).toString('base64url');
      await admin.query(`insert into taply.locations
        (id,merchant_id,name,slug) values($1,$2,'Roll in Love demo','boutique-demo')`,
        [publicLocation, A.merchant]);
      await admin.query(`insert into taply.public_enrollment_links
        (public_token,merchant_id,location_id,program_id) values($1,$2,$3,$4)`,
        [posterToken, A.merchant, publicLocation, A.program]);
      const signup = await post('enrollment/prepare', {
        publicToken: posterToken, firstName: 'Juliette', privacyAccepted: true,
      });
      const prepared = await signup.json();
      assert.equal(signup.status, 201);
      assert.equal(prepared.status, 'prepared');
      assert.match(prepared.claimToken, /^[A-Za-z0-9_-]{43}$/);
      const cannotScanPoster = await post('scan', {
        qrToken: posterToken, pin: '31415926',
        idempotencyKey: randomUUID(), purchaseConfirmed: true,
      });
      assert.equal(cannotScanPoster.status, 200);
      assert.equal((await cannotScanPoster.json()).credited, false);

      const newClient = await post('enrollment/confirm', {
        claimToken: prepared.claimToken, pin: '31415926',
        idempotencyKey: randomUUID(), customerPresent: true, purchaseConfirmed: true,
      });
      const joined = await newClient.json();
      assert.equal(newClient.status, 201);
      assert.equal(joined.status, 'confirmed');
      assert.equal(joined.firstVisitCredited, true);
      assert.equal(joined.visitCount, 1);
      const cardAfterJoin = await post('card/status', {
        qrToken: joined.qrToken, pin: '31415926',
      });
      assert.equal(cardAfterJoin.status, 200);
      assert.equal((await cardAfterJoin.json()).card.visitCount, 1);
      const claimedAgain = await post('enrollment/confirm', {
        claimToken: prepared.claimToken, pin: '31415926',
        idempotencyKey: randomUUID(), customerPresent: true, purchaseConfirmed: true,
      });
      assert.equal(claimedAgain.status, 404, 'Un claim ne peut pas donner deux cartes');

      const card = await withTenantTx(app, A.merchant, (client) =>
        rotateWalletQr(client, A.principal, {
          membershipId: A.membership, idempotencyKey: randomUUID(),
        }));
      const qr = card.qrToken;
      const denied = await post('scan', {
        qrToken: qr, pin: 'wrong',
        idempotencyKey: randomUUID(), purchaseConfirmed: true,
      });
      assert.equal(denied.status, 400, 'Malformed PIN must fail input validation');
      const wrong = await post('scan', {
        qrToken: qr, pin: '00000000',
        idempotencyKey: randomUUID(), purchaseConfirmed: true,
      });
      assert.equal(wrong.status, 403, 'Validly formatted but incorrect PIN denied');

      const scan = await post('scan', {
        qrToken: qr, pin: '31415926',
        idempotencyKey: randomUUID(), purchaseConfirmed: true,
      });
      assert.equal(scan.status, 200);
      const scanResult = await scan.json();
      assert.equal(scanResult.credited, true);

      const status = await post('card/status', { qrToken: qr, pin: '31415926' });
      assert.equal(status.status, 200);
      assert.equal((await status.json()).card.visitCount, 1);

      const noGiftYet = await post('redeem', {
        qrToken: qr, pin: '31415926', idempotencyKey: randomUUID(),
        expectedCycleNumber: scanResult.cycleNumber, giftHandedOver: true,
      });
      assert.equal(noGiftYet.status, 200);
      assert.equal((await noGiftYet.json()).redeemed, false);

      await admin.query(`update taply.membership_states
        set visit_count=5,reward_pending=true,last_credited_at=now()-interval '3 hours'
        where membership_id=$1`, [A.membership]);
      const claimedGift = await post('redeem', {
        qrToken: qr, pin: '31415926', idempotencyKey: randomUUID(),
        expectedCycleNumber: scanResult.cycleNumber, giftHandedOver: true,
      });
      assert.equal(claimedGift.status, 200);
      assert.equal((await claimedGift.json()).redeemed, true);

      const revoke = await post('devices/revoke', {
        deviceId: ownerDevice.deviceId, pin: '31415926',
      });
      assert.equal(revoke.status, 200);
      assert.equal((await revoke.json()).revoked, true);
      const blocked = await post('card/status', { qrToken: qr, pin: '31415926' });
      assert.equal(blocked.status, 403, 'Revoked staff device cannot access customer');
    } finally {
      if (old === undefined) delete process.env[envKey];
      else process.env[envKey] = old;
    }
  });

  await test('Dashboard clients: prénom, état réel, aucune fuite inter-commerce', async () => {
    const alice = await withTenantTx(app, A.merchant, client =>
      merchantCustomers(client, A.principal));
    assert.ok(alice.length >= 1);
    assert.ok(alice.every(customer => customer.programId === A.program));
    assert.ok(alice.every(customer => !Object.hasOwn(customer, 'qrToken')));
    assert.ok(alice.every(customer => !Object.hasOwn(customer, 'email')));
    const bob = await withTenantTx(app, B.merchant, client =>
      merchantCustomers(client, B.principal));
    assert.ok(bob.every(customer => customer.programId === B.program));
    assert.equal(await withTenantTx(app, A.merchant, client =>
      merchantCustomers(client, { ...A.principal, role: 'staff' })), undefined);
  });

  await test('Surveillance propriétaire: employés, appareil et journaux RLS sans secret', async () => {
    const ownerView = await withTenantTx(app, A.merchant, client =>
      securityOverview(client, A.principal));
    assert.ok(ownerView.devices.length >= 1, 'Un appareil owner activé doit être listé');
    assert.ok(ownerView.recentActivity.length >= 1, 'Les passages sont audités');
    assert.ok(ownerView.recentActivity.some(event =>
      event.kind === 'reward' && event.performedBy === A.principal.merchantUserId));
    assert.ok(ownerView.recentActivity.some(event =>
      event.kind === 'visit' && event.performedBy === A.principal.merchantUserId));
    assert.ok(ownerView.devices.every(device => device.merchantUserId !== B.principal.merchantUserId));
    assert.ok(ownerView.recentActivity.every(event => event.membershipId !== B.membership));
    const serialized = JSON.stringify(ownerView);
    for (const sensitive of ['token_hash', 'pin_verifier', 'pin_salt', 'idempotency_key']) {
      assert.ok(!serialized.includes(sensitive), sensitive + ' ne doit pas être divulgué');
    }
    const staffDenied = await withTenantTx(app, A.merchant, client =>
      securityOverview(client, { ...A.principal, role: 'staff' }));
    assert.equal(staffDenied, undefined);
    const otherView = await withTenantTx(app, B.merchant, client =>
      securityOverview(client, B.principal));
    assert.equal(otherView.devices.length, 0);
    assert.ok(otherView.recentActivity.every(event => event.membershipId !== A.membership));
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
