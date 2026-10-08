/** Remplacement d'un QR compromis — un nouveau secret affiché une seule fois. */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { runIdempotent } from '../db/idempotency.js';
import { generateWalletQrToken, hashWalletQrToken } from './qr-token.js';

const request = z.strictObject({ membershipId: z.uuid(), idempotencyKey: z.uuid() });

export async function rotateWalletQr(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  input: { membershipId: string; idempotencyKey: string },
): Promise<{ rotated: boolean; membershipId: string; qrToken?: string } | undefined> {
  if (!['owner', 'staff'].includes(principal.role) || !request.safeParse(input).success) {
    return undefined;
  }
  const membership = await client.query<{ id: string }>(
    `select m.id from taply.memberships m
       join taply.loyalty_programs p on p.id=m.program_id
         and p.merchant_id=m.merchant_id
       join taply.merchants mer on mer.id=m.merchant_id
      where m.id=$1 and m.merchant_id=$2 and m.status='active'
        and p.status='active' and mer.status='active'
      for update of m`,
    [input.membershipId, principal.merchantId],
  );
  if (membership.rowCount !== 1) return undefined;

  const fingerprint = createHash('sha256')
    .update(principal.merchantId + ':' + input.membershipId)
    .digest('hex');
  let raw: string | undefined;
  const result = await runIdempotent<{ rotated: true; membershipId: string }>(
    client,
    { merchantId: principal.merchantId, operation: 'rotate_wallet_qr',
      idempotencyKey: input.idempotencyKey, fingerprint },
    async () => {
      const previous = await client.query<{ token_hash: string }>(
        `select token_hash from taply.wallet_qr_tokens
         where membership_id=$1 and merchant_id=$2 and revoked_at is null
         for update`,
        [input.membershipId, principal.merchantId],
      );
      const oldHash = previous.rows[0]?.token_hash ?? null;
      if (oldHash !== null) {
        const revoked = await client.query(
          `update taply.wallet_qr_tokens set revoked_at=now()
            where membership_id=$1 and merchant_id=$2 and revoked_at is null`,
          [input.membershipId, principal.merchantId],
        );
        if (revoked.rowCount !== 1) throw new Error('Wallet QR revocation failed');
      }
      const next = generateWalletQrToken();
      const hashed = hashWalletQrToken(next);
      const issued = await client.query(
        `insert into taply.wallet_qr_tokens(membership_id,merchant_id,token_hash)
         values($1,$2,$3)`,
        [input.membershipId, principal.merchantId, hashed],
      );
      if (issued.rowCount !== 1) throw new Error('Wallet QR issue failed');
      const audited = await client.query(
        `insert into taply.wallet_qr_rotations
         (membership_id,merchant_id,performed_by,old_hash,new_hash)
         values($1,$2,$3,$4,$5)`,
        [input.membershipId, principal.merchantId, principal.merchantUserId, oldHash, hashed],
      );
      if (audited.rowCount !== 1) throw new Error('Wallet QR audit failed');
      raw = next;
      return { rotated: true, membershipId: input.membershipId };
    },
  );
  return { ...result, ...(raw === undefined ? {} : { qrToken: raw }) };
}
