# Merchant Auth V1 — Phase 3A / 3B

No secret in this document. Status: **MERCHANT AUTH V1 STAGING CERTIFICATION = PASS**, and **DEPLOYED STAGING AUTH FREEZE = PASS** (see `docs/certification/DEPLOYED_STAGING_AUTH_CERTIFICATION.md`). The Auth DB foundation (`merchant_users`/`merchant_sessions`, migrations 11/12) is live and certified on staging; Phase 3B2 found two real-staging RLS bugs in the real application flow, and both are now fixed and proven end-to-end against real staging PostgreSQL, both locally and through the real deployed Vercel Preview origin. Migration 13 (`session_revocation_policy`) is applied and certified. **Production is still not certified and not deployed** — no Production environment variables, no Production Auth-capable deployment; everything above covers staging only.

## Four separate layers — never conflated

1. **Supabase Auth authenticates identity.** Email/password verification only. Taply never sees or stores a password; Supabase never sees Taply's own session model.
2. **`taply.merchant_users` authorizes that identity to a merchant.** An authenticated Supabase identity with no row here (or a `disabled` one) gets **no** Taply session — Supabase authentication alone is insufficient.
3. **The Taply session maintains application authentication.** An opaque, server-generated, HttpOnly-cookie-carried token — never a Supabase JWT, never anything the browser can read or construct.
4. **TenantContext enforces DB tenant isolation**, exactly as certified in Phase 2B — unchanged, untouched by this phase. The Auth layer's only job is to correctly *derive* `merchantId` server-side before handing off to the existing `withTenantTx`/RLS machinery; it never decides tenant isolation itself.

## Trust boundaries

```
browser / user
  ↓ (opaque cookie only — no merchantId, no role, no JWT, no JSON)
Taply server session resolution (backend/auth/session.ts)
  ↓ (derives merchantId/role server-side, from the DB, inside one transaction)
TenantContext (backend/db/tenant-context.ts — unchanged)
  ↓
business query, under RLS
```

**A raw DB client holding `taply_app`'s credentials could, in principle, set `app.merchant_id` to anything.** This is not a finding against RLS — RLS's job is exactly what it's certified to do: *given* a `TenantContext`, prevent that transaction from reading/writing another tenant. The real claim this document makes is narrower and correct: **when the Taply backend establishes `TenantContext = X`, it does so only after deriving `X` itself, server-side, from a verified session — never from a value the browser supplied.** Proving the backend never derives `merchantId` from client-controlled input is this phase's job (see Login flow below); proving Postgres then enforces it is Phase 2B's already-certified job.

## Login flow

```
POST /api/auth/login  { email, password }
  → Origin check (fail-closed)
  → Zod validation (max lengths, email shape)
  → fresh Supabase Auth client (never a shared singleton — see below)
  → supabase.auth.signInWithPassword(email, password)
  → on failure: generic AUTH_INVALID, nothing else observable
  → on success: supabase.auth.signOut({ scope: 'local' })  — NEVER plain signOut()
  → resolveMerchantUserByAuthId(authUserId)  — exact WHERE + RLS, status='active' only
  → if absent: generic AUTH_INVALID (same shape as bad credentials)
  → createLoginSession(...)  — new opaque token, hashed before storage
  → HttpOnly cookie set, Max-Age ≤ absolute session lifetime
  → 200 { authenticated: true, merchantId, role }
```

**Why a fresh Supabase client per login call, never a module-scope singleton:** `persistSession: false` only disables writing to a storage adapter — it does not stop `auth-js` from holding the signed-in session in the client instance's own memory. A shared singleton reused across concurrent requests on the same warm Fluid Compute instance could let one caller's in-memory auth state bleed into another's. Constructing a new client is cheap (no network call at construction time) and eliminates the risk category entirely rather than relying on timing (`signOut({scope:'local'})` running fast enough).

**Why `signOut({ scope: 'local' })` and never plain `signOut()`:** the JS SDK's default scope is `global`, which would invalidate every Supabase Auth session that identity holds anywhere — not what a login flow should ever do as a side effect. `local` clears only this client's own in-memory state. A failure here is logged (`auth.supabase_cleanup_failed`, no secret) and treated as non-fatal — no Supabase token is ever persisted or returned to the browser regardless of whether this call succeeds.

## Session model

- `taply.merchant_sessions.token_hash` — SHA-256 hex of the raw token, **never the raw token itself**, ever, anywhere (not DB, not logs, not URLs).
- Raw token: `crypto.randomBytes(32)` (256 bits), base64url. Exists only in server memory for the duration of the request, and in the browser's HttpOnly cookie.
- Resolution (`withAuthenticatedTx`, `backend/auth/session.ts`): one transaction, three sequential transaction-local GUCs —
  1. `app.session_token_hash` → finds the exact active session (explicit `WHERE` **and** independent RLS policy, same two-layer pattern as Phase 2B's public-lookup design)
  2. `app.auth_user_id` → finds the exact, active `merchant_users` row for that session's identity (same two-layer pattern)
  3. `app.merchant_id` → only now does TenantContext begin — handed to the business callback
- Every successful resolution touches the session (`last_seen_at`, `idle_expires_at = LEAST(now() + idle lifetime, absolute_expires_at)`) — **idle can never push past absolute**, enforced in SQL, not application logic.
- `COMMIT`/`ROLLBACK` clears all three GUCs — guaranteed by PostgreSQL's transaction-local `set_config` semantics, identical mechanism to the certified `TenantContext`.

## Cookie model

- Name: `__Host-taply_session` in staging/production (forces `Secure`, `Path=/`, no `Domain` — enforced by Hono's `prefix: 'host'`, never hand-rolled). Plain `taply_session` in local development only (no HTTPS on localhost) — **never weakened in staging/production for local convenience.**
- `HttpOnly`, `SameSite=Lax`.
- Value: the raw opaque token, nothing else — no JSON, no JWT, no merchantId/role/authUserId.
- `Max-Age` ≤ `SESSION_ABSOLUTE_SECONDS` — the cookie can never outlive what the server would accept anyway.

## RLS pre-auth lookup

Both `merchant_users.auth_user_lookup` and `merchant_sessions.session_token_lookup` follow the exact pattern certified for `public_enrollment_links.public_token_lookup` in Phase 2B: an explicit application-level `WHERE`, **and** an independent RLS policy requiring the exact same transaction-local GUC — two layers, neither alone trusted. `merchant_users` grants `taply_app` **SELECT only** (no write grant at all — staff/owner administration is a separate, not-yet-built controlled workflow). `merchant_sessions` grants `SELECT, INSERT`, and `UPDATE` scoped to exactly five columns (`last_seen_at`, `idle_expires_at`, `reauthenticated_at`, `revoked_at`, `updated_at`) — never the identity/tenant columns, never `token_hash`, never `created_at`. No `DELETE` grant anywhere — revocation is `revoked_at`, never a physical delete (traceability).

## Role model

V1, deliberately flat: `owner` ⊇ `staff` (owner satisfies every staff-level check). `requireRole(required, actual)` is a tested primitive (`backend/auth/role.ts`) — **not wired into any route yet**, since no owner-only business route exists in this phase.

## Session expiration

- Idle: default 2h (`SESSION_IDLE_SECONDS`), renewed on each authenticated request, bounded by SQL `LEAST(...)` against absolute.
- Absolute: default 12h (`SESSION_ABSOLUTE_SECONDS`), never extended, period.
- Both computed from **database time** (`now()`), not the application server's clock.
- Config validated: bounded 60s–30 days, rejects 0/negative/NaN, and `idle > absolute` is refused at config-load time, not discovered at runtime.

## Logout

`POST /api/auth/logout` — Origin-protected, sets `revoked_at = now()` on the exact session (idempotent: 0 rows matched is not an error), **always** clears the cookie and returns success regardless of whether a session existed. Never leaks session existence through a different response shape.

### Real-staging finding B — logout vs PostgreSQL RLS, fixed and certified on staging

Phase 3B2's real end-to-end staging certification found that `UPDATE taply.merchant_sessions SET revoked_at = now() WHERE token_hash = $1` — the exact logout statement, using no `RETURNING` clause — was **rejected by PostgreSQL** with `new row violates row-level security policy for table "merchant_sessions"`, reproduced three times in isolation against real staging Postgres.

**Root cause:** SELECT policies participate in UPDATE visibility and checks, not only in `SELECT` statements. Under `FORCE ROW LEVEL SECURITY`, PostgreSQL requires the row to remain visible under an applicable `SELECT` policy after the update — confirmed empirically: updating an unrelated column (`last_seen_at`) succeeded, updating `revoked_at` to `now()` failed, and setting `revoked_at` to `NULL` (a no-op that keeps the row matching) succeeded again. `session_token_lookup` (the normal-authentication SELECT policy) requires `revoked_at IS NULL` — but revocation's entire purpose is to make that condition false for the row being revoked. No GUC-ordering trick fixes this (unlike finding A below): the row that was selectable before the `UPDATE` is, by design, no longer selectable under the *same* policy afterward.

**Fix (migration `20261007120013_session_revocation_policy.sql`):** a capability separation, not a weakening. Normal authentication and revocation now use two different transaction-local GUCs, never set together in the same code path:

- **Normal auth** (unchanged): raw cookie → SHA-256 → `app.session_token_hash` → `session_token_lookup` (active-only: not revoked, not expired) → merchant/auth resolution.
- **Revocation** (new): raw cookie → SHA-256 → `app.session_revoke_token_hash` → `session_revoke_lookup` (exact token match only — deliberately does **not** require `revoked_at IS NULL` or unexpired, since the whole point is to find and revoke a session regardless of its current state) → `revoke_own_session` (UPDATE, same exact-token `USING`/`WITH CHECK`) → `revoked_at = now()`.

`session_revoke_lookup` grants no authentication power: it only lets the exact row matching a caller-supplied token hash be found for revocation, never lets that token authenticate a request (that remains exclusively `session_token_lookup`'s job, untouched by this migration). A revoked session stays invisible to normal authentication — the two GUCs are never set together, and `session_token_lookup`'s `revoked_at IS NULL` condition is unchanged. `revokeSession()` still keeps its explicit application-level `WHERE token_hash = $1 AND revoked_at IS NULL` — RLS remains a second, independent layer, never the sole row selector. No new grant was added (the existing column-scoped `UPDATE` grant already covers `revoked_at`/`updated_at`); no `DELETE` grant, no table-wide `UPDATE` grant, no `SECURITY DEFINER`, no role escalation.

## CSRF / Origin

`backend/http/origin.ts` — exact `Origin` header match against configured `APP_ORIGIN`, for `POST`/`PUT`/`PATCH`/`DELETE` only. Mounted **per-route** on `/auth/login` and `/auth/logout` (not as a global app-wide middleware — an earlier draft mounted it globally and broke two unrelated, already-certified Phase 1 tests by rejecting their POST requests; scoping it to the actual cookie-authenticated routes was the correct fix, and matches the instruction's own framing: "cookie authentication requires explicit Origin protection," not "every mutation anywhere requires it today"). Fail-closed: missing `APP_ORIGIN` config, missing `Origin` header, or any mismatch (scheme/host/port) → rejected. Future authenticated mutating routes must explicitly add `originCheck` themselves — it is not inherited automatically.

## Logging / redaction

Safe events only: `auth.login.success`, `auth.login.failed` (reason code only, never which specific reason externally), `auth.session.invalid`, `auth.logout`, `auth.origin.rejected`, `auth.supabase_cleanup_failed`, `db.pool.error`, `db.transaction.rollback_failed`. All routed through the existing `backend/core/logger.ts` + `redact.ts` pipeline (reused, not reinvented). Request bodies are never logged. Verified by test: captured log output never contains the password, email, raw token, or Supabase tokens for any scenario exercised.

## Known blockers (explicit, not hidden)

- **LOGIN RATE LIMITING = PRE-PRODUCTION BLOCKER.** No in-memory limiter was built (explicitly forbidden — a `Map`/`Set`/per-process counter is not a security control in a multi-instance serverless deployment). Auth routes remain **staging-only** until a distributed anti-abuse mechanism is added and certified. Supabase's own Auth rate limits are useful defense-in-depth but are not Taply's complete business-flow abuse protection.
- **No public signup, no automatic merchant provisioning.** Not built, not planned for this phase. Merchant provisioning is a separate, controlled, not-yet-designed workflow.
- **Recent re-auth not implemented.** Future invariant, documented now: sensitive owner-only actions (billing changes, owner/staff changes, security settings, credential actions, business deletion) will require a fresh credential verification — a future flow re-prompting email+password and checking the returned Supabase `user.id` matches the currently authenticated identity, still using only the publishable key, never an elevated Supabase credential.
- **No `SUPABASE_SECRET_KEY`/`service_role` anywhere in this phase**, deliberately. If a future requirement appears to need one, that is a stop-and-justify moment, not a default to reach for.

## Publishable-key validation — correction (pre-staging review)

`SUPABASE_PUBLISHABLE_KEY` is now validated against the strict `sb_publishable_...` prefix only — nothing else is accepted, including every legacy JWT-shaped key (`anon` or `service_role`). The earlier guard checked `!value.includes('service_role')`, which does **not** reliably reject a real legacy `service_role` JWT: the role lives inside the JWT's base64-encoded payload, not necessarily as a literal substring of the encoded token. Rather than attempt to decode and filter legacy JWTs, this 2026 Taply stack requires the new Supabase API-key format outright and rejects everything else — `sb_secret_...`, any `eyJ...`-shaped JWT (legacy anon or service_role alike), and arbitrary strings. Supabase's current key model replaces legacy anon/service_role with `sb_publishable_`/`sb_secret_`; a `service_role`/`secret` key bypasses RLS, so the prefix is the only guarantee this code relies on. See `tests/unit/config.test.ts` (`SUPABASE_PUBLISHABLE_KEY : nouveau format sb_publishable_ uniquement`) for the five rejection/acceptance cases, all using shape-only fake values, never a real key.

## Auth-identity delete semantics — correction (pre-staging review)

Migration 11's `merchant_users.auth_user_id → auth.users(id)` is `ON DELETE RESTRICT`, not `ON DELETE CASCADE` as originally drafted. The original CASCADE choice conflicted with migration 12: `merchant_sessions` references `merchant_users` with `ON DELETE RESTRICT`, so deleting `auth.users` while an active session exists would still fail — just later in the cascade chain, with a confusing constraint-violation error instead of an explicit, immediate one. Deleting an authentication identity is a controlled application lifecycle operation, not something an implicit database cascade should perform. A future account-deletion workflow must explicitly, in order: (1) revoke/remove the Taply sessions tied to the identity, (2) remove the `merchant_users` mapping, (3) delete the Supabase Auth identity. No trigger, no `SECURITY DEFINER`, no deletion workflow is built in this phase — only the constraint that prevents an implicit cascade from doing that work silently. See `tests/unit/db/migrations-static-invariants.test.ts` (`merchant_users : auth_user_id -> auth.users(id) est ON DELETE RESTRICT, jamais CASCADE`, `merchant_sessions : FK composite vers merchant_users reste ON DELETE RESTRICT`, and the explicit RESTRICT/RESTRICT regression test).

## Real-staging findings (Phase 3B2 dynamic end-to-end certification)

Both found by running the real `backend/auth/*`/`backend/http/routes/auth.ts` code — never a reimplementation — against real staging Postgres through real Supavisor with CA-verified TLS. Neither was caught by unit/integration tests beforehand, because those mock the database entirely and never exercise real RLS.

**A — `INSERT … RETURNING id` vs RLS (fixed, application code only).** `createLoginSession` set `app.auth_user_id`/`app.merchant_id` before the insert but generated the session token — and so computed `token_hash` — only *inside* the same function, after those `set_config` calls, never pushing it into `app.session_token_hash` before the `INSERT … RETURNING id`. Under `FORCE ROW LEVEL SECURITY`, `RETURNING`'s output is filtered by the table's `SELECT` policy (`session_token_lookup`, which requires that exact GUC) — so every real login failed with `new row violates row-level security policy`. Fixed by computing the token/hash first and setting `app.session_token_hash` before the insert, in `backend/auth/session.ts`. No schema change needed — this was a pure call-ordering bug.

**B — logout vs RLS (fixed and certified on staging — see the Logout section above).** Structurally different from A: no GUC-ordering fix exists, because the SELECT policy's condition (`revoked_at IS NULL`) is *necessarily* falsified by the very write revocation performs. The fix is a separate RLS capability (`session_revoke_lookup` + `revoke_own_session`, migration `20261007120013_session_revocation_policy.sql`) scoped to its own GUC (`app.session_revoke_token_hash`), never reused for authentication. Migration 13 is now applied on staging and was proven against real PostgreSQL for active, idle-expired, absolute-expired, wrong-token, idempotent, exact-row-isolation, COMMIT-leak and ROLLBACK-leak scenarios. Final end-to-end Auth recertification also proved logout A returns 200, revokes only A, A `/auth/me` becomes 401, and B remains authenticated.

## Read-only Supabase Auth configuration — UNKNOWN

Attempted via the session's available read-only tooling (`execute_sql` SELECT-only, `list_tables`, `get_advisors`). Provider enablement (email/password on/off), public signup state, email-confirmation requirement, asymmetric JWT signing state, and legacy-vs-publishable key existence are **platform/Management-API-level settings**, not rows in any queryable Postgres table in this project (the `auth.*` tables present — `users`, `identities`, `sessions`, `sso_providers`, `mfa_*`, `oauth_*`, etc. — hold runtime data, not provider configuration). Genuinely unknown from this session, not guessed. Confirming these requires Dashboard access (Authentication → Providers / Sign In / URL Configuration) or the Supabase Management API, neither available to this session's tooling.
