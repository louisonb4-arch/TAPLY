/**
 * Parcours SaaS complet, bout en bout, contre PostgreSQL réel (PGlite) :
 * toutes les migrations du dépôt, rôle taply_app, RLS forcée, vraie app
 * Hono (HTTP, cookies, Origin). Seuls Supabase Auth (login par mot de
 * passe) et l'API Stripe sont remplacés : la session commerçant est
 * insérée telle que login.ts la crée, et Stripe par un faux client.
 *
 * Ce test NE certifie PAS la concurrence réelle (PGlite sérialise les
 * transactions) : voir scripts/certification/staging-concurrency.mjs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../backend/core/config.js';
import { createApp } from '../../backend/http/app.js';
import { hashSessionToken } from '../../backend/auth/token.js';
import { derivePin } from '../../backend/auth/staff-device.js';
import { deriveTagKeys } from '../../backend/nfc/keys.js';
import { setStripeApiForTests } from '../../backend/http/routes/billing.js';
import { signStripePayload, type StripeApi, type StripeSubscription } from '../../backend/billing/stripe.js';
import { simulateSunUrlParams } from '../helpers/ntag424-sim.js';
import { createTestDb, type TestDb } from '../helpers/pglite-db.js';
import { TestBrowser } from '../helpers/http-client.js';
import { captureLogger } from '../helpers/capture-logger.js';

const ORIGIN = 'https://taply.example';
const MASTER_HEX = 'a1'.repeat(16) + 'b2'.repeat(16);
const PIN = '482915';
const UID = Buffer.from('04A1B2C3D4E5F6', 'hex');

let t: TestDb;
let app: ReturnType<typeof createApp>;

interface Merchant { merchantId: string; ownerId: string; browser: TestBrowser; deviceToken: string }

async function provisionMerchant(name: string, email: string): Promise<Merchant> {
  const authId = randomUUID();
  await t.admin(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
     values ($1, $2, now(), $3::jsonb)`,
    [authId, email, JSON.stringify({ taply_onboarding_v1: true, taply_business_name: name })]);
  // Même RPC que le premier login réel après confirmation de l'e-mail.
  await t.admin(`select set_config('request.jwt.claim.sub', $1, false)`, [authId]);
  const [created] = await t.admin<{ id: string }>('select public.taply_complete_merchant_signup_v1() as id');
  await t.admin(`select set_config('request.jwt.claim.sub', '', false)`);
  const merchantId = created!.id;
  const [owner] = await t.admin<{ id: string }>('select id from taply.merchant_users where auth_user_id = $1', [authId]);
  const raw = randomBytes(32).toString('base64url');
  await t.admin(
    `insert into taply.merchant_sessions
       (merchant_id, merchant_user_id, auth_user_id, token_hash, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, $4, now() + interval '2 hours', now() + interval '12 hours')`,
    [merchantId, owner!.id, authId, hashSessionToken(raw)]);
  // Appareil approuvé (équivalent de /loyalty/devices/approve + activate).
  const deviceToken = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  await t.admin(
    `insert into taply.staff_devices (merchant_id, merchant_user_id, token_hash, pin_salt, pin_verifier)
     values ($1, $2, $3, $4, $5)`,
    [merchantId, owner!.id, createHash('sha256').update('taply:staff:device:v1:' + deviceToken).digest('hex'),
      salt, await derivePin(PIN, salt)]);
  const browser = new TestBrowser(app, ORIGIN, '198.51.100.' + Math.floor(Math.random() * 200));
  browser.cookies.set('taply_session', raw);
  browser.cookies.set('taply_staff_device', deviceToken);
  return { merchantId, ownerId: owner!.id, browser, deviceToken };
}

let tagCounter = 10;
function tapProof(uid = UID, ctr = ++tagCounter) {
  const keys = deriveTagKeys(Buffer.from(MASTER_HEX, 'hex'), uid, 1);
  return { ...simulateSunUrlParams({ sdmMetaReadKey: keys.sdmMetaReadKey, sdmFileReadKey: keys.sdmFileReadKey, uid, readCtr: ctr }), ctr };
}
/** Corps exact envoyé par la page /t : { e, c }. */
function tap(uid = UID, ctr = ++tagCounter) {
  const { e, c } = tapProof(uid, ctr);
  return { e, c };
}

async function rewindCooldown(membershipId: string, hours = 3) {
  await t.admin(
    `update taply.membership_states set last_credited_at = last_credited_at - make_interval(hours => $2)
      where membership_id = $1`, [membershipId, hours]);
}

// vitest.config : unstubEnvs → l'environnement est reposé avant chaque test.
beforeEach(() => {
  vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
  vi.stubEnv('TAPLY_QR_ANONYMOUS_V1', 'enabled');
  vi.stubEnv('TAPLY_STAFF_PIN_PEPPER', 'test-pepper-'.repeat(4));
  vi.stubEnv('TAPLY_NFC_MASTER_KEY', MASTER_HEX);
  vi.stubEnv('TAPLY_BILLING_MODE', 'disabled');
});

beforeAll(async () => {
  t = await createTestDb();
  const { logger } = captureLogger();
  app = createApp({ config: loadConfig({ APP_ENV: 'test', APP_ORIGIN: ORIGIN }), logger, dbPool: t.pool });
}, 60_000);

afterAll(async () => {
  setStripeApiForTests(undefined);
  vi.unstubAllEnvs();
  await t?.close();
});

describe('Taply SaaS — parcours de bout en bout (PostgreSQL + RLS)', () => {
  let m1: Merchant;
  let m2: Merchant;
  let publicCode = '';
  const customer = () => new TestBrowser(app, ORIGIN, '192.0.2.' + Math.floor(Math.random() * 200));
  let alice: TestBrowser;
  let aliceCard = '';

  it('1-4. commerçant : configure seuil + plusieurs récompenses, publie, récupère son QR', async () => {
    m1 = await provisionMerchant('Café Lumière', 'owner1@taply.test');
    m2 = await provisionMerchant('Boulangerie Nord', 'owner2@taply.test');
    const before = await m1.browser.get('/api/loyalty/setup');
    expect(before.status).toBe(200);
    expect(before.json.published).toBe(false);
    expect(before.json.threshold).toBe(5);

    const saved = await m1.browser.patch('/api/loyalty/setup', {
      threshold: 4, rewards: ['Café offert', 'Viennoiserie offerte'],
      rewardTerms: 'Un passage par achat, 2 h minimum entre deux passages.', cardColor: '#1F3A2B', textColor: '#FFFFFF',
    });
    expect(saved).toMatchObject({ status: 200, json: { saved: true } });
    const duplicate = await m1.browser.patch('/api/loyalty/setup', {
      threshold: 4, rewards: ['Café offert', 'café offert'], rewardTerms: '', cardColor: '#1F3A2B', textColor: '#FFFFFF',
    });
    expect(duplicate.status).toBe(422);

    const published = await m1.browser.post('/api/loyalty/setup/publish');
    expect(published).toMatchObject({ status: 200, json: { published: true } });
    const setup = await m1.browser.get('/api/loyalty/setup');
    expect(setup.json.rewards).toEqual([{ key: 'r1', title: 'Café offert' }, { key: 'r2', title: 'Viennoiserie offerte' }]);
    expect(setup.json.enrollmentUrl).toMatch(/^https:\/\/taply\.example\/join\.html\?code=[A-Za-z0-9_-]{32}$/);
    expect(setup.json.contract.canChangeNow).toBe(false);
    publicCode = new URL(setup.json.enrollmentUrl).searchParams.get('code')!;
    const qr = await m1.browser.get('/api/loyalty/setup/qr.svg');
    expect(qr.status).toBe(200);
    expect(String(qr.json)).toContain('<svg');
    // Brouillon figé après publication.
    const locked = await m1.browser.patch('/api/loyalty/setup', {
      threshold: 3, rewards: ['Autre'], rewardTerms: '', cardColor: '#1F3A2B', textColor: '#FFFFFF',
    });
    expect(locked.status).toBe(409);
  });

  it('5-6. client : scanne le QR public, carte anonyme créée à 0 sans aucune donnée personnelle', async () => {
    alice = customer();
    const program = await alice.get('/api/c/program?code=' + publicCode);
    expect(program.status).toBe(200);
    expect(program.json.program).toMatchObject({ merchantName: 'Café Lumière', threshold: 4 });
    expect(program.json.card).toBeNull();
    expect(alice.cookies.has('taply_cid_nonce')).toBe(true);

    const enrolled = await alice.post('/api/c/enroll', { publicToken: publicCode });
    expect(enrolled.status).toBe(200);
    expect(enrolled.json.created).toBe(true);
    expect(enrolled.json.card).toMatchObject({ visits: 0, threshold: 4, rewardPending: false, cycleNumber: 1 });
    aliceCard = enrolled.json.card.membershipId;
    expect(alice.cookies.has('taply_cid')).toBe(true);

    // Rechargement / double clic : jamais une seconde carte ni identité.
    const again = await alice.post('/api/c/enroll', { publicToken: publicCode });
    expect(again.json).toMatchObject({ created: false, card: { membershipId: aliceCard } });
    const reopened = await alice.get('/api/c/program?code=' + publicCode);
    expect(reopened.json.card.membershipId).toBe(aliceCard);

    // Requête concurrente d'un 2e onglet sans cookie d'identité mais même nonce.
    const tab2 = new TestBrowser(app, ORIGIN);
    tab2.cookies.set('taply_cid_nonce', alice.cookies.get('taply_cid_nonce')!);
    const joined = await tab2.post('/api/c/enroll', { publicToken: publicCode });
    expect(joined.json.card.membershipId).toBe(aliceCard);

    const [counts] = await t.admin<{ ids: number; cards: number; visits: number }>(
      `select (select count(*)::int from taply.customer_identities) ids,
              (select count(*)::int from taply.memberships) cards,
              (select count(*)::int from taply.visit_ledger) visits`);
    expect(counts).toEqual({ ids: 1, cards: 1, visits: 0 });
  });

  it('7-9. QR personnel scanné par l’employé : lecture sans crédit, puis passage validé', async () => {
    const qr = await alice.post(`/api/c/cards/${aliceCard}/qr`);
    expect(qr.status).toBe(200);
    expect(qr.json.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(qr.json.qrSvg).toContain('<svg');

    // Sans PIN et appareil verrouillé : refus.
    const locked = await m1.browser.post('/api/loyalty/card/lookup', { qrToken: qr.json.qrToken });
    expect(locked.status).toBe(403);
    const looked = await m1.browser.post('/api/loyalty/card/lookup', { qrToken: qr.json.qrToken, pin: PIN });
    expect(looked).toMatchObject({ status: 200, json: { found: true, card: { visits: 0, threshold: 4 } } });
    const [ledger] = await t.admin<{ n: number }>('select count(*)::int n from taply.visit_ledger');
    expect(ledger?.n).toBe(0);

    // Appareil déverrouillé 15 min : validation sans ressaisir le PIN.
    const scan = await m1.browser.post('/api/loyalty/scan', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), purchaseConfirmed: true,
    });
    expect(scan.json).toMatchObject({ credited: true, visitCount: 1, rewardUnlocked: false });
    const card = await alice.get(`/api/c/cards/${aliceCard}`);
    expect(card.json.card.visits).toBe(1);
    expect(card.json.history[0].kind).toBe('visit_qr');
    const dash = await m1.browser.get('/api/loyalty/dashboard');
    expect(dash.json.stats).toMatchObject({ cards: 1, visits: 1 });
  });

  it('10. délai de 2 h : QR puis NFC refusés avant 2 h (horloge serveur, même carte)', async () => {
    const qr = await alice.post(`/api/c/cards/${aliceCard}/qr`);
    const second = await m1.browser.post('/api/loyalty/scan', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), purchaseConfirmed: true,
    });
    expect(second.json).toMatchObject({ credited: false, reason: { kind: 'cooldown_active' } });

    // Appairage de la puce : le propriétaire ouvre une fenêtre puis la touche.
    expect((await m1.browser.post('/api/loyalty/nfc/pairing', { label: 'Comptoir' })).status).toBe(200);
    const pairTap = tapProof();
    const paired = await m1.browser.post('/api/c/nfc/tap', { e: pairTap.e, c: pairTap.c });
    expect(paired.json).toEqual({ status: 'paired', label: 'Comptoir' });
    // NFC automatique refusé tant que le commerçant ne l'a pas activé.
    const off = await alice.post('/api/c/nfc/tap', tap());
    expect(off.json).toMatchObject({ status: 'denied', reason: 'nfc_disabled' });
    expect((await m1.browser.patch('/api/loyalty/program/preferences', {
      nfcAutoEnabled: true, notifyRewardUnlocked: true, notificationsEnabled: false,
    })).status).toBe(200);

    const nfc = await alice.post('/api/c/nfc/tap', tap());
    expect(nfc.json).toMatchObject({ status: 'denied', reason: 'cooldown' });
    expect(nfc.json.retryAfter).toBeTruthy();
  });

  it('NFC : passage automatique, anti-rejeu, compteur obsolète, puce inconnue, MAC falsifiée', async () => {
    await rewindCooldown(aliceCard);
    const proof = tapProof();
    const ok = await alice.post('/api/c/nfc/tap', { e: proof.e, c: proof.c });
    expect(ok.json).toMatchObject({ status: 'credited', firstVisit: false, card: { visits: 2 } });
    // Rechargement de la page par le même navigateur : idempotent, rien de plus.
    const reload = await alice.post('/api/c/nfc/tap', { e: proof.e, c: proof.c });
    expect(reload.json).toMatchObject({ status: 'already_processed', card: { visits: 2 } });
    // URL relayée à un autre téléphone : rejet.
    const relayed = await customer().post('/api/c/nfc/tap', { e: proof.e, c: proof.c });
    expect(relayed.json).toMatchObject({ status: 'denied', reason: 'replay' });
    // Compteur plus ancien jamais consommé : rejet (obsolète).
    const stale = tap(UID, proof.ctr - 1);
    expect((await customer().post('/api/c/nfc/tap', stale)).json).toMatchObject({ reason: 'replay' });
    // MAC falsifiée.
    const forged = { e: proof.e, c: (proof.c[0] === 'A' ? 'B' : 'A') + proof.c.slice(1) };
    expect((await alice.post('/api/c/nfc/tap', forged)).json).toMatchObject({ status: 'denied', reason: 'invalid' });
    // Puce authentique mais jamais rattachée (et pas de session propriétaire).
    const foreign = tap(Buffer.from('04FFEEDDCCBBAA', 'hex'), 5);
    expect((await alice.post('/api/c/nfc/tap', foreign)).json).toMatchObject({ reason: 'unknown_tag' });
    const visits = await t.admin<{ n: number }>('select count(*)::int n from taply.visit_ledger');
    expect(visits[0]!.n).toBe(2);
  });

  it('NFC première visite : identité + carte + premier passage en une seule lecture', async () => {
    const bob = customer();
    const res = await bob.post('/api/c/nfc/tap', tap());
    expect(res.json).toMatchObject({ status: 'credited', firstVisit: true, card: { visits: 1, threshold: 4 } });
    expect(bob.cookies.has('taply_cid')).toBe(true);
    const cards = await bob.get('/api/c/cards');
    expect(cards.json.cards).toHaveLength(1);
  });

  it('puce désactivée puis compromise : refus, NFC automatique coupé', async () => {
    const view = await m1.browser.get('/api/loyalty/nfc');
    const tagId = view.json.tags[0].id;
    expect(view.json.tags[0]).toMatchObject({ status: 'active', label: 'Comptoir' });
    expect((await m1.browser.post(`/api/loyalty/nfc/tags/${tagId}/status`, { status: 'disabled' })).status).toBe(200);
    await rewindCooldown(aliceCard);
    expect((await alice.post('/api/c/nfc/tap', tap())).json).toMatchObject({ reason: 'tag_inactive' });
    expect((await m1.browser.post(`/api/loyalty/nfc/tags/${tagId}/status`, { status: 'active' })).status).toBe(200);
    expect((await m1.browser.patch('/api/loyalty/program/preferences', {
      nfcAutoEnabled: true, notifyRewardUnlocked: true, notificationsEnabled: false })).status).toBe(200);
    const events = await m1.browser.get(`/api/loyalty/nfc/tags/${tagId}/events`);
    expect(events.json.events.map((e: { outcome: string }) => e.outcome)).toEqual(
      expect.arrayContaining(['paired', 'credited', 'denied_replay', 'denied_tag_inactive', 'enrolled_credited']));
  });

  it('11-14. récompense : seuil atteint, carte bloquée, choix client, remise unique, nouveau cycle', async () => {
    for (const expected of [3, 4]) {
      await rewindCooldown(aliceCard);
      const r = await alice.post('/api/c/nfc/tap', tap());
      expect(r.json).toMatchObject({ status: 'credited', card: { visits: expected } });
      if (expected === 4) expect(r.json.rewardUnlocked).toBe(true);
    }
    await rewindCooldown(aliceCard);
    expect((await alice.post('/api/c/nfc/tap', tap())).json).toMatchObject({ reason: 'reward_pending' });
    const qr = await alice.post(`/api/c/cards/${aliceCard}/qr`);
    const blocked = await m1.browser.post('/api/loyalty/scan', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), purchaseConfirmed: true });
    expect(blocked.json).toMatchObject({ credited: false, reason: { kind: 'reward_pending' } });

    const unknown = await alice.post(`/api/c/cards/${aliceCard}/reward`, { rewardKey: 'r9' });
    expect(unknown.status).toBe(409);
    const chosen = await alice.post(`/api/c/cards/${aliceCard}/reward`, { rewardKey: 'r2' });
    expect(chosen.json).toMatchObject({ chosen: true, reward: { key: 'r2', title: 'Viennoiserie offerte' } });
    const board = await m1.browser.get('/api/loyalty/rewards');
    expect(board.json.pending[0]).toMatchObject({ chosenReward: 'Viennoiserie offerte' });

    // Le comptoir ne peut pas imposer une autre récompense que celle choisie.
    const mismatch = await m1.browser.post('/api/loyalty/redeem', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), expectedCycleNumber: 1, rewardKey: 'r1', giftHandedOver: true });
    expect(mismatch.json).toMatchObject({ redeemed: false, reason: { kind: 'reward_choice_mismatch' } });
    const key = randomUUID();
    const redeem = await m1.browser.post('/api/loyalty/redeem', {
      qrToken: qr.json.qrToken, idempotencyKey: key, expectedCycleNumber: 1, giftHandedOver: true });
    expect(redeem.json).toMatchObject({ redeemed: true, completedCycle: 1, newCycleNumber: 2,
      reward: { key: 'r2', title: 'Viennoiserie offerte' } });
    // Coupure réseau → renvoi de la même requête : même réponse, aucune double remise.
    const retry = await m1.browser.post('/api/loyalty/redeem', {
      qrToken: qr.json.qrToken, idempotencyKey: key, expectedCycleNumber: 1, giftHandedOver: true });
    expect(retry.json).toEqual(redeem.json);
    const twice = await m1.browser.post('/api/loyalty/redeem', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), expectedCycleNumber: 1, giftHandedOver: true });
    expect(twice.json.redeemed).toBe(false);
    const ledger = await t.admin<{ n: number; title: string }>(
      'select count(*)::int n, max(reward_title) title from taply.redemption_ledger');
    expect(ledger[0]).toEqual({ n: 1, title: 'Viennoiserie offerte' });

    const card = await alice.get(`/api/c/cards/${aliceCard}`);
    expect(card.json.card).toMatchObject({ visits: 0, cycleNumber: 2, rewardPending: false, rewardsRedeemed: 1 });
    expect(card.json.history.map((h: { kind: string }) => h.kind)).toContain('reward');
    // Nouveau cycle : un passage est de nouveau possible (après le délai).
    await rewindCooldown(aliceCard);
    expect((await alice.post('/api/c/nfc/tap', tap())).json).toMatchObject({ status: 'credited', card: { visits: 1, cycleNumber: 2 } });
  });

  it('15. tableau de bord : vraies données agrégées', async () => {
    const dash = await m1.browser.get('/api/loyalty/dashboard');
    expect(dash.json.stats).toMatchObject({ cards: 2, rewardsHandedOver: 1, rewardsUnlocked: 1 });
    expect(dash.json.stats.visits).toBe(6);
    expect(dash.json.stats.nfcVisits).toBe(5);
    expect(dash.json.recentActivity.length).toBeGreaterThan(0);
    const customers = await m1.browser.get('/api/loyalty/customers');
    expect(customers.json.customers).toHaveLength(2);
    expect(Object.keys(customers.json.customers[0])).not.toContain('firstName');
    const history = await m1.browser.get(`/api/loyalty/customers/${aliceCard}/history`);
    expect(history.json.history.length).toBe(6);
  });

  it('16. isolation : un commerce ne voit ni ne modifie les cartes d’un autre, une identité ne voit que ses cartes', async () => {
    expect((await m2.browser.get('/api/loyalty/customers')).json.customers).toEqual([]);
    expect((await m2.browser.get(`/api/loyalty/customers/${aliceCard}/history`)).status).toBe(404);
    const qr = await alice.post(`/api/c/cards/${aliceCard}/qr`);
    const crossLookup = await m2.browser.post('/api/loyalty/card/lookup', { qrToken: qr.json.qrToken, pin: PIN });
    expect(crossLookup.status).toBe(404);
    const crossScan = await m2.browser.post('/api/loyalty/scan', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), purchaseConfirmed: true });
    expect(crossScan.json).toMatchObject({ credited: false, reason: { kind: 'qr_invalid' } });
    const nfcView = await m2.browser.get('/api/loyalty/nfc');
    expect(nfcView.json.tags).toEqual([]);
    const eve = customer();
    expect((await eve.get(`/api/c/cards/${aliceCard}`)).status).toBe(404);
    expect((await eve.post(`/api/c/cards/${aliceCard}/qr`)).status).toBe(404);
    // RLS directe : sans contexte, taply_app ne voit rien.
    const none = await t.asApp({}, async (db) => (await db.query('select id from taply.memberships')).rows);
    expect(none).toEqual([]);
    const otherTenant = await t.asApp({ 'app.merchant_id': m2.merchantId },
      async (db) => (await db.query('select id from taply.memberships')).rows);
    expect(otherTenant).toEqual([]);
    const identities = await t.asApp({ 'app.merchant_id': m1.merchantId },
      async (db) => (await db.query('select id from taply.customer_identities')).rows);
    expect(identities).toEqual([]);
  });

  it('modification contractuelle : verrou 30 jours, version, progression conservée', async () => {
    const tooSoon = await m1.browser.put('/api/loyalty/program/contract', { threshold: 6, rewards: ['Café offert'] });
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.json.status).toBe('too_soon');
    // Défense en profondeur : le trigger refuse aussi une version insérée directement.
    await expect(t.asApp({ 'app.merchant_id': m1.merchantId }, (db) => db.query(
      `insert into taply.program_rule_versions (merchant_id, program_id, version_no, rules, is_active)
       select merchant_id, program_id, 99, '{"threshold":3}'::jsonb, false from taply.program_publications
        where merchant_id = $1`, [m1.merchantId]))).rejects.toThrow(/contract_locked/);

    await t.admin(`update taply.program_publications set contract_changed_at = now() - interval '31 days'
                    where merchant_id = $1`, [m1.merchantId]);
    const updated = await m1.browser.put('/api/loyalty/program/contract', {
      threshold: 6, rewards: ['Café offert', 'Jus pressé'], reason: 'Nouvelle carte' });
    expect(updated.json).toMatchObject({ status: 'updated' });
    // Alice (cycle en cours) garde 4 passages ; un nouveau client a 6.
    expect((await alice.get(`/api/c/cards/${aliceCard}`)).json.card.threshold).toBe(4);
    const carol = customer();
    await carol.get('/api/c/program?code=' + publicCode);
    const carolCard = await carol.post('/api/c/enroll', { publicToken: publicCode });
    expect(carolCard.json.card.threshold).toBe(6);
    const versions = (await m1.browser.get('/api/loyalty/setup')).json.versions;
    expect(versions[0]).toMatchObject({ active: true, threshold: 6, reason: 'Nouvelle carte' });
    const again = await m1.browser.put('/api/loyalty/program/contract', { threshold: 7, rewards: ['Café offert'] });
    expect(again.json.status).toBe('too_soon');
  });

  it('récupération : code facultatif, haché, usage unique, anti-force brute', async () => {
    const issued = await alice.post('/api/c/recovery');
    expect(issued.json.recoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const [stored] = await t.admin<{ recovery_hash: string }>('select recovery_hash from taply.customer_identities where recovery_hash is not null');
    expect(stored!.recovery_hash).not.toContain(issued.json.recoveryCode.replace(/-/g, ''));
    const oldCookie = alice.cookies.get('taply_cid')!;

    const newPhone = customer();
    const bad = await newPhone.post('/api/c/recover', { recoveryCode: 'AAAAA-AAAAA-AAAAA-AAAAA' });
    expect(bad.status).toBe(401);
    const ok = await newPhone.post('/api/c/recover', { recoveryCode: issued.json.recoveryCode });
    expect(ok.json.recovered).toBe(true);
    expect(ok.json.newRecoveryCode).not.toBe(issued.json.recoveryCode);
    expect((await newPhone.get('/api/c/cards')).json.cards.map((c: { membershipId: string }) => c.membershipId)).toContain(aliceCard);
    // L'ancien téléphone (perdu) est déconnecté ; l'ancien code ne sert plus.
    const lost = new TestBrowser(app, ORIGIN);
    lost.cookies.set('taply_cid', oldCookie);
    expect((await lost.get('/api/c/cards')).json.identity).toBe(false);
    expect((await customer().post('/api/c/recover', { recoveryCode: issued.json.recoveryCode })).status).toBe(401);

    const attacker = new TestBrowser(app, ORIGIN, '203.0.113.250');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attacker.post('/api/c/recover', { recoveryCode: 'BBBBB-BBBBB-BBBBB-BBBB' + (i % 9 + 1) })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    alice = newPhone;
  });

  it('abonnement appliqué : sans abonnement actif, aucune opération ; webhook signé l’active', async () => {
    vi.stubEnv('TAPLY_BILLING_MODE', 'enforced');
    const qr = await alice.post(`/api/c/cards/${aliceCard}/qr`);
    await rewindCooldown(aliceCard);
    const refused = await m1.browser.post('/api/loyalty/scan', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), purchaseConfirmed: true });
    expect(refused.json).toMatchObject({ credited: false, reason: { kind: 'subscription_inactive' } });
    expect((await alice.post('/api/c/nfc/tap', tap())).json).toMatchObject({ reason: 'billing' });
    expect((await customer().post('/api/c/enroll', { publicToken: publicCode })).status).toBe(503);
    expect((await m1.browser.get('/api/billing/status')).json).toMatchObject({ level: 'setup_only', status: 'none' });

    const secret = 'whsec_' + 'c'.repeat(32);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_' + 'x'.repeat(24));
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
    vi.stubEnv('STRIPE_PRICE_ID', 'price_taply20');
    let sub: StripeSubscription = { id: 'sub_A1', customer: 'cus_A1', status: 'active', metadata: { merchant_id: m1.merchantId },
      priceId: 'price_taply20', currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 86400, cancelAtPeriodEnd: false };
    const checkouts: string[] = [];
    const fake: StripeApi = {
      createCheckoutSession: async (_p, key) => { checkouts.push(key); return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1', status: 'open', clientReferenceId: m1.merchantId, customer: null, subscription: null, expiresAt: Math.floor(Date.now() / 1000) + 3600 }; },
      retrieveCheckoutSession: async (id) => ({ id, url: 'https://checkout.stripe.test/' + id, status: 'open', clientReferenceId: m1.merchantId, customer: null, subscription: null, expiresAt: null }),
      retrieveSubscription: async () => sub,
      createPortalSession: async () => ({ url: 'https://billing.stripe.test/portal' }),
    };
    setStripeApiForTests(fake);

    const checkout = await m1.browser.post('/api/billing/checkout');
    expect(checkout.json.redirect).toBe('https://checkout.stripe.test/cs_test_1');
    // Double clic : session ouverte réutilisée, aucun second Checkout.
    expect((await m1.browser.post('/api/billing/checkout')).json.redirect).toBe('https://checkout.stripe.test/cs_test_1');
    expect(checkouts).toHaveLength(1);

    const send = (event: object, sig?: string) => {
      const body = JSON.stringify(event);
      return new TestBrowser(app, ORIGIN).request('POST', '/api/billing/webhook', body,
        { 'stripe-signature': sig ?? signStripePayload(body, secret, Math.floor(Date.now() / 1000)), Origin: '' });
    };
    const event = { id: 'evt_1', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'sub_A1', customer: 'cus_A1', metadata: { merchant_id: m1.merchantId } } } };
    expect((await send(event, 't=1,v1=' + '0'.repeat(64))).status).toBe(401);
    // La page de succès seule ne prouve rien : toujours pas d'accès.
    expect((await m1.browser.get('/api/billing/status')).json.level).toBe('setup_only');
    expect((await send(event)).json).toMatchObject({ outcome: 'applied' });
    expect((await send(event)).json).toMatchObject({ outcome: 'duplicate' });
    expect((await m1.browser.get('/api/billing/status')).json).toMatchObject({ level: 'full', status: 'active' });
    expect((await m1.browser.post('/api/billing/checkout')).status).toBe(409);
    const ok = await m1.browser.post('/api/loyalty/scan', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), purchaseConfirmed: true });
    expect(ok.json.credited).toBe(true);

    // Paiement échoué → past_due : période de grâce, opérations encore permises.
    sub = { ...sub, status: 'past_due' };
    await send({ ...event, id: 'evt_2', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_A1', customer: 'cus_A1' } } });
    expect((await m1.browser.get('/api/billing/status')).json.level).toBe('grace');
    // Un client Stripe étranger ne peut pas détourner l'abonnement du commerce.
    sub = { ...sub, id: 'sub_EVIL', customer: 'cus_EVIL', status: 'active' };
    expect((await send({ ...event, id: 'evt_3', data: { object: { id: 'sub_EVIL', customer: 'cus_EVIL' } } })).json.outcome).toBe('ignored');
    // Résiliation : lecture seule.
    sub = { id: 'sub_A1', customer: 'cus_A1', status: 'canceled', metadata: { merchant_id: m1.merchantId }, priceId: 'price_taply20', currentPeriodEnd: null, cancelAtPeriodEnd: false };
    await send({ ...event, id: 'evt_4', type: 'customer.subscription.deleted' });
    expect((await m1.browser.get('/api/billing/status')).json).toMatchObject({ level: 'read_only', status: 'canceled' });
    expect((await alice.get(`/api/c/cards/${aliceCard}`)).status).toBe(200);
    // Réabonnement : le même client Stripe est réutilisé (pas de doublon de compte).
    expect((await m1.browser.post('/api/billing/checkout')).status).toBe(200);
    expect((await m1.browser.post('/api/billing/portal')).json.redirect).toBe('https://billing.stripe.test/portal');
    vi.stubEnv('TAPLY_BILLING_MODE', 'disabled');
  });

  it('requêtes répétées : deux validations concurrentes ne créditent qu’une fois', async () => {
    await rewindCooldown(aliceCard);
    const qr = await alice.post(`/api/c/cards/${aliceCard}/qr`);
    const results = await Promise.all([0, 1, 2].map(() => m1.browser.post('/api/loyalty/scan', {
      qrToken: qr.json.qrToken, idempotencyKey: randomUUID(), purchaseConfirmed: true })));
    expect(results.filter((r) => r.json.credited === true)).toHaveLength(1);
  });
});
