/**
 * Envoi d'e-mails transactionnels (Resend, API HTTP). Clé uniquement côté
 * serveur (RESEND_API_KEY), jamais journalisée. Les adresses des
 * destinataires ne sont jamais écrites dans les journaux.
 */

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly replyTo?: string;
  /** Clé d'idempotence Resend (24 h) : un même rappel n'est pas envoyé deux fois. */
  readonly idempotencyKey: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class MailerError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Mail provider error ${status}`);
    this.name = 'MailerError';
    this.status = status;
  }
}

export interface MailConfig {
  readonly apiKey: string;
  readonly from: string;
  readonly supportEmail: string | null;
  readonly opsEmail: string | null;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

function email(value: string | undefined): string | null {
  const v = value?.trim();
  return v && EMAIL_RE.test(v) ? v : null;
}

export function mailConfig(env: Readonly<Record<string, string | undefined>> = process.env): MailConfig | undefined {
  const apiKey = env['RESEND_API_KEY']?.trim();
  const from = env['TAPLY_EMAIL_FROM']?.trim();
  if (!apiKey || !/^re_[A-Za-z0-9_]+$/.test(apiKey)) return undefined;
  // « Nom <adresse> » ou adresse seule.
  if (!from || !(EMAIL_RE.test(from) || /^[^<>]{1,60} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}>$/.test(from))) return undefined;
  return { apiKey, from, supportEmail: email(env['TAPLY_SUPPORT_EMAIL']), opsEmail: email(env['TAPLY_OPS_EMAIL']) };
}

export function resendMailer(config: MailConfig, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(message) {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new MailerError(response.status);
    },
  };
}

/** Échappement HTML minimal pour les valeurs insérées dans un modèle. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
