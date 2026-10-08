-- Additive nonce-based first-enrollment idempotency.
-- The short-lived HttpOnly nonce is not a customer identity or fingerprint.
-- It only associates concurrent first POSTs from one browser.
alter table taply.anonymous_card_sessions
  add column enrollment_nonce_hash text
    unique check(enrollment_nonce_hash is null
      or enrollment_nonce_hash ~ '^[0-9a-f]{64}$');
create index anon_sessions_enrollment_nonce_idx
  on taply.anonymous_card_sessions(merchant_id,program_id,enrollment_nonce_hash)
  where enrollment_nonce_hash is not null;
