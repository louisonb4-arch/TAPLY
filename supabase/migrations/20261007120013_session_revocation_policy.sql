-- Phase 3B2 correction — logout vs PostgreSQL RLS.
--
-- Real staging proved (Phase 3B2 dynamic certification) that
-- `UPDATE taply.merchant_sessions SET revoked_at = now() WHERE
-- token_hash = $1` fails under FORCE ROW LEVEL SECURITY with "new row
-- violates row-level security policy" — even without a RETURNING clause.
-- Root cause, confirmed by direct isolated reproduction against real
-- Postgres: the UPDATE still requires the row to remain visible under an
-- applicable SELECT policy. `session_token_lookup` requires
-- `revoked_at IS NULL` — but revocation's entire purpose is to make that
-- condition false. The row that was selectable before the UPDATE is no
-- longer selectable after it, under the SAME policy used for normal
-- authentication — so the UPDATE is rejected, structurally, regardless
-- of ordering tricks (unlike the separate INSERT ... RETURNING bug fixed
-- in application code, this one cannot be fixed by reordering
-- set_config calls: no GUC value can make a revoked row satisfy
-- `revoked_at IS NULL`).
--
-- Fix: a SEPARATE, narrower capability for revocation only — a distinct
-- GUC (`app.session_revoke_token_hash`, never reused for normal
-- authentication) and two new policies scoped to that GUC alone. The
-- revocation SELECT policy deliberately does NOT require
-- `revoked_at IS NULL`/unexpired — a revoked or expired session must
-- still be exact-token-identifiable so its `revoked_at` can be set (an
-- idempotent re-revoke is harmless; the application's own explicit
-- `WHERE token_hash = $1 AND revoked_at IS NULL` already prevents a
-- redundant write). This grants NO new authentication power: nothing
-- about `session_token_lookup` (normal auth) changes, and the revoke
-- capability has no bearing on whether a session is treated as
-- authenticated — it only lets the exact row matching a caller-supplied
-- token hash be found and revoked.
--
-- A revoked session remains invisible to normal authentication: the
-- revoke GUC and the auth GUC are two different transaction-local
-- settings, never set together, and `session_token_lookup`'s
-- `revoked_at IS NULL` condition is untouched — a session visible via
-- `session_revoke_lookup` is not thereby visible via `session_token_lookup`.

create policy session_revoke_lookup on taply.merchant_sessions
  for select to taply_app
  using (
    token_hash = nullif(current_setting('app.session_revoke_token_hash', true), '')
  );

create policy revoke_own_session on taply.merchant_sessions
  for update to taply_app
  using (
    token_hash = nullif(current_setting('app.session_revoke_token_hash', true), '')
  )
  with check (
    token_hash = nullif(current_setting('app.session_revoke_token_hash', true), '')
  );

-- Pas de nouveau grant : les colonnes déjà accordées en UPDATE
-- (last_seen_at, idle_expires_at, reauthenticated_at, revoked_at,
-- updated_at) couvrent déjà ce que la révocation modifie. Pas de GRANT
-- DELETE, pas de GRANT UPDATE table entière, pas de SECURITY DEFINER,
-- aucune élévation de rôle.
