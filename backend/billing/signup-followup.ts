/**
 * Tâche quotidienne de suivi des paiements « sans compte » :
 *   - 48 h après le paiement, si l'espace n'est pas créé : un rappel au
 *     payeur (une seule fois), avec le lien de finalisation ;
 *   - 14 jours après : dossier signalé (journal + e-mail à l'exploitant)
 *     pour annulation et remboursement MANUELS dans Stripe ;
 *   - abonnement déjà terminé chez Stripe (annulé/remboursé) : dossier clos.
 *
 * L'e-mail du payeur n'est jamais stocké : il est relu chez Stripe au
 * moment de l'envoi. Chaque action est d'abord réservée en base
 * (UPDATE … WHERE … IS NULL) : deux exécutions simultanées n'envoient pas
 * deux fois ; un envoi échoué libère la réservation pour le lendemain.
 */
import type { Pool, PoolClient } from 'pg';
import { withTx } from '../db/tenant-context.js';
import type { Logger } from '../core/logger.js';
import { escapeHtml, type Mailer } from '../notify/mailer.js';
import type { StripeApi } from './stripe.js';

export const REMINDER_AFTER_HOURS = 48;
export const FLAG_AFTER_DAYS = 14;
const BATCH = 50;
const ENDED = new Set(['canceled', 'incomplete_expired']);

export interface FollowupOptions {
  readonly origin: string;
  readonly supportEmail: string | null;
  readonly opsEmail: string | null;
  /** Stripe en mode test : liens vers le tableau de bord de test. */
  readonly testMode: boolean;
}

export interface FollowupReport {
  reminded: number;
  flagged: number;
  closed: number;
  failed: number;
}

interface DueRow {
  checkout_session_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  created_at: Date;
  remind: boolean;
  flag: boolean;
}

async function jobTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.signup_job', 'followup-v1']);
    return fn(client);
  });
}

/** Réserve une action (colonne encore vide) ; false si une autre exécution l'a prise. */
async function reserve(pool: Pool, sessionId: string, column: 'reminder_sent_at' | 'flagged_at'): Promise<boolean> {
  return jobTx(pool, async (client) => (await client.query(
    `update taply.signup_checkouts set ${column} = now()
      where checkout_session_id = $1 and status = 'paid' and ${column} is null`, [sessionId])).rowCount === 1);
}

async function release(pool: Pool, sessionId: string, column: 'reminder_sent_at' | 'flagged_at'): Promise<void> {
  await jobTx(pool, (client) => client.query(
    `update taply.signup_checkouts set ${column} = null where checkout_session_id = $1 and status = 'paid'`, [sessionId]));
}

function frDate(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(date);
}

export function reminderEmail(input: { email: string; paidAt: Date; origin: string; supportEmail: string | null }) {
  const link = `${input.origin}/activer.html`;
  const help = input.supportEmail
    ? `Une question, ou vous souhaitez être remboursé ? Écrivez-nous à ${input.supportEmail}.`
    : 'Une question, ou vous souhaitez être remboursé ? Répondez simplement à cet e-mail.';
  const text = [
    'Bonjour,',
    '',
    `Votre abonnement Taply (20 € / mois) a bien été payé le ${frDate(input.paidAt)}, mais votre espace commerçant n’est pas encore créé.`,
    '',
    `Créez-le en une minute : ${link}`,
    `Utilisez l’adresse ${input.email} : votre abonnement y sera rattaché automatiquement.`,
    '',
    help,
    '',
    'L’équipe Taply',
  ].join('\n');
  const html = `<p>Bonjour,</p>
<p>Votre abonnement Taply (20&nbsp;€ / mois) a bien été payé le ${escapeHtml(frDate(input.paidAt))}, mais votre espace commerçant n’est pas encore créé.</p>
<p><a href="${escapeHtml(link)}">Créer mon espace</a> — une minute suffit. Utilisez l’adresse <strong>${escapeHtml(input.email)}</strong> : votre abonnement y sera rattaché automatiquement.</p>
<p>${escapeHtml(help)}</p>
<p>L’équipe Taply</p>`;
  return { subject: 'Finalisez votre espace Taply', text, html };
}

export function flagEmail(input: { row: DueRow; testMode: boolean }) {
  const base = `https://dashboard.stripe.com/${input.testMode ? 'test/' : ''}`;
  const sub = `${base}subscriptions/${input.row.stripe_subscription_id}`;
  const text = [
    `Paiement Taply sans espace créé depuis ${FLAG_AFTER_DAYS} jours : à annuler et rembourser manuellement.`,
    '',
    `Payé le : ${frDate(input.row.created_at)}`,
    `Abonnement Stripe : ${input.row.stripe_subscription_id} — ${sub}`,
    `Client Stripe : ${input.row.stripe_customer_id}`,
    `Session Checkout : ${input.row.checkout_session_id}`,
    '',
    'Dans Stripe : ouvrir l’abonnement → Annuler l’abonnement (immédiatement) → rembourser le paiement.',
    'Le dossier se clôt tout seul au prochain passage de la tâche quand l’abonnement est annulé.',
  ].join('\n');
  const html = `<p>Paiement Taply sans espace créé depuis ${FLAG_AFTER_DAYS} jours : <strong>à annuler et rembourser manuellement</strong>.</p>
<ul><li>Payé le : ${escapeHtml(frDate(input.row.created_at))}</li>
<li>Abonnement Stripe : <a href="${escapeHtml(sub)}">${escapeHtml(input.row.stripe_subscription_id)}</a></li>
<li>Client Stripe : ${escapeHtml(input.row.stripe_customer_id)}</li>
<li>Session Checkout : ${escapeHtml(input.row.checkout_session_id)}</li></ul>
<p>Dans Stripe : ouvrir l’abonnement → Annuler l’abonnement (immédiatement) → rembourser le paiement. Le dossier se clôt tout seul au prochain passage de la tâche.</p>`;
  return { subject: `[Taply] Paiement sans compte depuis ${FLAG_AFTER_DAYS} jours — remboursement à faire`, text, html };
}

export async function runSignupFollowups(
  pool: Pool, stripe: StripeApi, mailer: Mailer | undefined, options: FollowupOptions, log: Logger,
): Promise<FollowupReport> {
  const report: FollowupReport = { reminded: 0, flagged: 0, closed: 0, failed: 0 };
  const due = await jobTx(pool, async (client) => (await client.query<DueRow>(
    `select checkout_session_id, stripe_customer_id, stripe_subscription_id, created_at,
            (reminder_sent_at is null and created_at <= now() - make_interval(hours => $1)
              and created_at > now() - make_interval(days => $2)) as remind,
            (flagged_at is null and created_at <= now() - make_interval(days => $2)) as flag
       from taply.signup_checkouts
      where status = 'paid'
        and ((reminder_sent_at is null and created_at <= now() - make_interval(hours => $1)
              and created_at > now() - make_interval(days => $2))
          or (flagged_at is null and created_at <= now() - make_interval(days => $2)))
      order by created_at limit $3`,
    [REMINDER_AFTER_HOURS, FLAG_AFTER_DAYS, BATCH])).rows);

  for (const row of due) {
    try {
      const sub = await stripe.retrieveSubscription(row.stripe_subscription_id);
      if (ENDED.has(sub.status)) {
        // Annulé ou remboursé depuis Stripe : dossier clos, plus de rappel.
        const closed = await jobTx(pool, async (client) => (await client.query(
          `update taply.signup_checkouts set status = 'canceled' where checkout_session_id = $1 and status = 'paid'`,
          [row.checkout_session_id])).rowCount === 1);
        if (closed) { report.closed += 1; log.info('billing.signup_checkout.closed', {}); }
        continue;
      }

      if (row.remind && mailer && await reserve(pool, row.checkout_session_id, 'reminder_sent_at')) {
        const session = await stripe.retrieveCheckoutSession(row.checkout_session_id);
        try {
          if (!session.customerEmail) throw new Error('no_payer_email');
          const mail = reminderEmail({ email: session.customerEmail, paidAt: row.created_at, origin: options.origin,
            supportEmail: options.supportEmail });
          await mailer.send({ to: session.customerEmail, ...mail, idempotencyKey: `taply-signup-reminder-${row.checkout_session_id}`,
            ...(options.supportEmail ? { replyTo: options.supportEmail } : {}) });
          report.reminded += 1;
          log.info('billing.signup_checkout.reminder_sent', {});
        } catch (error) {
          await release(pool, row.checkout_session_id, 'reminder_sent_at');
          throw error;
        }
      }

      if (row.flag && await reserve(pool, row.checkout_session_id, 'flagged_at')) {
        // Signalement : toujours journalisé ; e-mail à l'exploitant s'il est configuré.
        log.warn('billing.signup_checkout.refund_due', {
          subscription: row.stripe_subscription_id, customer: row.stripe_customer_id, paidAt: row.created_at.toISOString() });
        if (mailer && options.opsEmail) {
          try {
            await mailer.send({ to: options.opsEmail, ...flagEmail({ row, testMode: options.testMode }),
              idempotencyKey: `taply-signup-flag-${row.checkout_session_id}` });
          } catch (error) {
            await release(pool, row.checkout_session_id, 'flagged_at');
            throw error;
          }
        }
        report.flagged += 1;
      }
    } catch (error) {
      report.failed += 1;
      log.warn('billing.signup_checkout.followup_failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  return report;
}
