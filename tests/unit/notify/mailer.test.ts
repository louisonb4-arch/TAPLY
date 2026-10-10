import { describe, expect, it } from 'vitest';
import { escapeHtml, mailConfig, MailerError, resendMailer } from '../../../backend/notify/mailer.js';

const env = { RESEND_API_KEY: 're_test_abc123', TAPLY_EMAIL_FROM: 'Taply <noreply@taply.fr>',
  TAPLY_SUPPORT_EMAIL: 'support@taply.fr', TAPLY_OPS_EMAIL: 'ops@taply.fr' };

describe('mailConfig', () => {
  it('exige une clé Resend et un expéditeur valides ; adresses invalides ignorées', () => {
    expect(mailConfig(env)).toEqual({ apiKey: 're_test_abc123', from: 'Taply <noreply@taply.fr>',
      supportEmail: 'support@taply.fr', opsEmail: 'ops@taply.fr' });
    expect(mailConfig({ ...env, RESEND_API_KEY: 'sk_test_x' })).toBeUndefined();
    expect(mailConfig({ ...env, TAPLY_EMAIL_FROM: 'pas une adresse' })).toBeUndefined();
    expect(mailConfig({ ...env, TAPLY_OPS_EMAIL: 'x' })?.opsEmail).toBeNull();
  });
});

describe('resendMailer', () => {
  it('POST /emails avec clé Bearer, Idempotency-Key et reply_to', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"x"}', { status: 200 });
    }) as unknown as typeof fetch;
    await resendMailer(mailConfig(env)!, fetchImpl).send({ to: 'client@commerce.fr', subject: 'Objet', text: 'T', html: '<p>T</p>',
      replyTo: 'support@taply.fr', idempotencyKey: 'taply-k1' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer re_test_abc123');
    expect(headers['Idempotency-Key']).toBe('taply-k1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: 'Taply <noreply@taply.fr>', to: ['client@commerce.fr'],
      subject: 'Objet', text: 'T', html: '<p>T</p>', reply_to: 'support@taply.fr' });
  });

  it('erreur du fournisseur → MailerError (statut seulement)', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 422 })) as unknown as typeof fetch;
    await expect(resendMailer(mailConfig(env)!, fetchImpl).send({ to: 'a@b.fr', subject: 's', text: 't', html: 'h',
      idempotencyKey: 'k' })).rejects.toBeInstanceOf(MailerError);
  });

  it('échappe le HTML inséré dans les modèles', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
