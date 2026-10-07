# Merchant Auth V1 — Staging Certification (frozen)

No secret in this document.

## Identity

- Project: `taply-staging`
- Project ref: `jfkcrpbrdrzwhjtkdmxx`
- Git HEAD at final certification: `3156f4e1e37c0cdd3d3504d822bf555562cba5b5`
- Migrations: 13 local / 13 remote
- Production: untouched
- Git push: not part of certification
- Security Advisor after final run: 0 findings

## Final verdict

**MERCHANT AUTH V1 STAGING CERTIFICATION = PASS**

This verdict was obtained with real Supabase Auth users, real Supavisor Transaction Pooler, real PostgreSQL RLS, CA-verified TLS, real Taply application code, real concurrent A/B sessions, and complete cleanup after certification.

## Certified flow

The following end-to-end chain is proven on staging:

```
email + password
→ Supabase Auth server-side verification
→ active merchant_users mapping
→ opaque Taply session
→ __Host-taply_session cookie
→ /api/auth/me
→ server-derived merchantId / role
→ transaction-local Auth GUCs
→ TenantContext
→ PostgreSQL RLS
→ logout / revocation
```

The browser receives no Supabase access token or refresh token.

## Certified properties

| Property | Result |
|---|---|
| Real login, Merchant A | PASS |
| Real login, Merchant B | PASS |
| Cookie: `__Host-taply_session` | PASS |
| HttpOnly / Secure / SameSite=Lax / Path=/ / no Domain | PASS |
| `/api/auth/me` A → A | PASS |
| `/api/auth/me` B → B | PASS |
| Cache-Control: no-store | PASS |
| Supabase tokens exposed to browser | NONE |
| Client-supplied merchantId influences principal | NO |
| A can read B under authenticated TenantContext | NO |
| B can read A under authenticated TenantContext | NO |
| wrongTenantResults | 0 |
| Concurrent principal isolation 10 / 25 / 50 | PASS |
| Disabled mapping blocks existing session | PASS |
| Disabled mapping blocks new login generically | PASS |
| Idle expiry | PASS |
| Absolute expiry | PASS |
| Revoked session authentication | DENIED |
| Logout A | PASS |
| Second logout A | PASS / idempotent |
| Logout A affects B | NO |
| Auth GUC leak after COMMIT | 0 / 25 |
| Auth GUC leak after ROLLBACK | 0 / 25 |
| Secret/token matches in captured logs | 0 |
| Certification fixtures after cleanup | 0 |
| Certification Auth users after cleanup | 0 |
| Temporary `taply_app` password after cleanup | NULL |
| Structural drift | NONE |

## Live database state after certification

- 10 Taply tables.
- RLS enabled on all Taply tables.
- FORCE RLS remains enabled where designed.
- `merchant_sessions` has 5 policies:
  - `session_token_lookup`
  - `insert_own_session`
  - `update_own_session`
  - `session_revoke_lookup`
  - `revoke_own_session`
- Total Taply policy count: 18.
- Grants and role attributes remained unchanged by final certification.
- 13 migrations local / 13 remote.
- Security Advisor: 0 findings.

## Real-staging findings discovered before freeze

The real E2E certification found two CRITICAL pre-production bugs that the mocked unit/integration DB tests could not expose.

### Finding A — INSERT ... RETURNING vs RLS

`createLoginSession()` inserted a new session with `RETURNING id` without first setting `app.session_token_hash`.

Under FORCE RLS, the returned row also had to satisfy the session SELECT policy, so every real login failed.

Fix:

- generate raw token
- hash it
- set `app.auth_user_id`
- set `app.merchant_id`
- set `app.session_token_hash`
- then perform `INSERT ... RETURNING id`

Result:

**fixed and proven against real staging PostgreSQL.**

### Finding B — logout vs RLS

Normal session lookup deliberately requires `revoked_at IS NULL`.

A logout changes `revoked_at` to non-null, so PostgreSQL rejected the UPDATE because the post-update row no longer satisfied the normal authentication SELECT policy.

Fix:

Migration 13 introduced a separate revocation capability:

- normal authentication:
  `app.session_token_hash` → active-only `session_token_lookup`
- revocation:
  `app.session_revoke_token_hash` → exact-row `session_revoke_lookup` + `revoke_own_session`

The normal authentication policy was not weakened.

Result:

**fixed and proven live for active, idle-expired, absolute-expired, wrong-token, exact-row isolation, idempotent revoke, COMMIT cleanup and ROLLBACK cleanup.**

Final E2E recertification then proved:

- logout returns 200;
- A becomes unauthenticated;
- B remains authenticated;
- second logout is idempotent.

## Trust boundaries frozen

1. Supabase Auth authenticates the identity.
2. `merchant_users` authorizes that identity to one merchant.
3. Taply's opaque session authenticates application requests.
4. TenantContext + PostgreSQL RLS enforce tenant isolation.

A browser-provided merchantId is never authoritative.

The Taply session cookie contains only random opaque entropy.

Raw session tokens are never stored in PostgreSQL; only SHA-256 hashes are stored.

## Frozen Auth invariants

The following require reopening Merchant Auth certification if changed:

- `merchant_users` identity-to-merchant semantics;
- `merchant_sessions` schema;
- session token generation or hashing;
- `app.auth_user_id` semantics;
- `app.session_token_hash` semantics;
- `app.session_revoke_token_hash` semantics;
- Auth-related RLS policies;
- Auth-related grants;
- session expiry rules;
- `withAuthenticatedTx()` resolution order;
- `createLoginSession()` GUC order;
- `revokeSession()` revocation capability;
- cookie name or security attributes;
- Origin/CSRF enforcement;
- owner/staff role semantics;
- Supabase token exposure model.

Changes outside these boundaries may still need targeted tests, but these items invalidate this certification unless the relevant live suite is rerun.

## Known non-blocking UNKNOWN

The following Supabase platform-level settings were not queryable through the available read-only SQL path and remain explicitly UNKNOWN:

- public signup setting;
- provider enablement configuration;
- email confirmation configuration;
- asymmetric JWT-signing state.

They must be checked explicitly before production.

## Pre-production blockers still open

Merchant Auth V1 is certified for staging, not production.

Before production:

- distributed login rate limiting / anti-abuse;
- explicit Supabase Auth platform-setting review;
- recent re-auth for sensitive owner actions;
- global Supabase SSL enforcement rollout;
- monitoring/alerting;
- backup/PITR + restore drill;
- GDPR/account-deletion workflow;
- production secret/config review.

These do not invalidate the staging PASS.

## Freeze

**MERCHANT AUTH V1 FREEZE = PASS**

Staging evidence is complete for the current Auth V1 design.

The next product phase may build on this frozen boundary without reopening Auth unless one of the frozen invariants above changes.
