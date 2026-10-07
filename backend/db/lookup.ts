/**
 * Résolution publique pré-tenant : jeton exact → merchant/location/program.
 *
 * Seul module qui ouvre une transaction sans contexte tenant (withTx, pas
 * withTenantTx) — délibéré, et volontairement isolé ici pour rester le
 * seul endroit du code à le faire.
 *
 * Deux couches indépendantes, aucune ne suffit seule à documenter l'autre
 * comme superflue :
 *  1. filtre applicatif explicite (`WHERE public_token = $1`, paramétré) ;
 *  2. RLS (`public_token_lookup`) — exige en plus l'égalité exacte avec
 *     `app.lookup_token` côté base, quelle que soit la requête émise par
 *     taply_app sur cette table (donc même si le WHERE ci-dessus était un
 *     jour supprimé ou cassé par erreur, RLS continue de limiter la
 *     visibilité à la ligne dont le jeton correspond au GUC posé).
 * Jeton : 160 bits d'entropie, généré côté Node — jamais par la base.
 */

import type { Pool } from 'pg';
import { z } from 'zod';
import { withTx } from './tenant-context.js';

const tokenSchema = z.string().min(16).max(512);

export interface PublicEnrollmentTarget {
  readonly merchantId: string;
  readonly locationId: string;
  readonly programId: string;
}

interface Row {
  readonly merchant_id: string;
  readonly location_id: string;
  readonly program_id: string;
}

/** `undefined` : jeton invalide, inconnu, ou lien inactif — même forme dans les trois cas. */
export async function resolvePublicEnrollmentLink(pool: Pool, token: string): Promise<PublicEnrollmentTarget | undefined> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) return undefined;

  return withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.lookup_token', parsed.data]);
    const result = await client.query<Row>(
      'select merchant_id, location_id, program_id from taply.public_enrollment_links where public_token = $1',
      [parsed.data],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { merchantId: row.merchant_id, locationId: row.location_id, programId: row.program_id };
  });
}
