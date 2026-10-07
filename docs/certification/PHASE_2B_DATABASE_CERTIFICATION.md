# Phase 2B — Database Certification (frozen)

No secret in this document. Pooler host, port, and role names below are not secrets — the password never appears here.

## Identity

- Project: `taply-staging`
- Project ref: `jfkcrpbrdrzwhjtkdmxx`
- Git HEAD at certification time: `307c60e73d0f5a3625f670084849f903ebe213e9`
- Migrations: 10 local / 10 remote (`supabase_migrations.schema_migrations`), applied once, no repair, no manual SQL.
- Pooler: Supavisor Transaction Pooler, `aws-0-eu-west-1.pooler.supabase.com:6543`, role `taply_app.jfkcrpbrdrzwhjtkdmxx`.
- CA: Supabase Root 2021 CA, SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, validated independently (`openssl x509`) before use, not copied into the repo.

## Phase 2 structural certification — PASS

Verified read-only against the live catalog (not just migration source):

- 8 tables in schema `taply`: `merchants`, `locations`, `loyalty_programs`, `program_rule_versions`, `customers`, `memberships`, `idempotency_requests`, `public_enrollment_links`.
- `relrowsecurity = true` and `relforcerowsecurity = true` on all 8.
- `pg_policies`: 12 policies total, matching design exactly — `public_enrollment_links` has exactly `public_token_lookup`, no `select_tenant`.
- Ownership: schema + all 8 tables owned by `taply_owner`. `taply_app` owns zero relations.
- Roles: `taply_owner` (`NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`), `taply_app` (`LOGIN`, same five `NO*` attributes). No `taply_migrator`, no `taply_system`.
- `taply_app` grants: `SELECT` only on `merchants`/`locations`/`loyalty_programs`/`program_rule_versions`/`public_enrollment_links`; `SELECT, INSERT` on `customers`/`memberships`; `SELECT, INSERT` + column-scoped `UPDATE (status, response, updated_at)` on `idempotency_requests`. No `DELETE` anywhere. No `GRANT ALL`.
- Zero functions in schema `taply` — no `SECURITY DEFINER`.
- `pg_net`, `pg_cron`: not installed.
- Security Advisor: 0 findings.

## Phase 2B dynamic certification — PASS

All of the following were proven against the **real** Supavisor pooler, real PostgreSQL, real `taply_app` role, real CA-verified TLS, real concurrent connections — not unit tests with fakes:

| test | result |
|---|---|
| TLS handshake, CA-verified, `rejectUnauthorized: true` | `encrypted: true`, `authorized: true`, `authorizationError: null` |
| `current_user` | `taply_app` |
| RLS enabled + forced (live) | true / true on all 8 |
| Absent tenant context | 0 rows, no error |
| Empty tenant context (`set_config(..., '', true)`) | 0 rows, no `::uuid` cast exception |
| Application `withTenantTx` rejects a non-UUID `merchantId` before opening any connection | confirmed |
| Merchant A cannot read Merchant B (and inverse) | confirmed, both directions, via bare-PK queries (RLS did the filtering, not an application `WHERE`) |
| Cross-tenant customer insert | blocked |
| Cross-program membership (customer A + program B) | blocked by composite FK |
| `DELETE` as `taply_app` | denied |
| `CREATE TABLE` in `taply` as `taply_app` | denied |
| `SELECT auth.users` / `SELECT storage.objects` | denied |
| `SET ROLE taply_owner` / `SET SESSION AUTHORIZATION postgres` | denied |
| COMMIT context leak, 50 cycles A/B alternating, `max:1` pool | 0 leaks |
| ROLLBACK context leak, 50 cycles A/B alternating | 0 leaks |
| Public lookup: active token → correct IDs; wrong/inactive token → no row (same shape, no oracle) | confirmed |
| `app.lookup_token` leak after use | none |
| Supavisor concurrency ramp | 10 → 25 → 50, **max reached: 50**, 0 errors, **`wrongTenantResults: 0`** at every tier |
| Idempotency, 50 concurrent calls, same key + same fingerprint | callback ran exactly once, 1 distinct logical result |
| Idempotency, 10 concurrent calls, same key + conflicting fingerprints | correct conflicts, never two logical mutations |
| Cleanup | all `taply-cert-*` fixtures removed, all 8 tables back to 0 rows, `taply_app.rolpassword IS NULL` confirmed |
| Structural drift after dynamic run | zero — re-confirmed 8 tables / RLS / FORCE RLS / 12 policies / role attributes / grants / Security Advisor |

## Known INFO findings (not security failures)

1. **Supavisor password-propagation latency.** Rotating `taply_app`'s password via the CLI's Management-API-backed `db query` path propagates to Supavisor's auth layer with non-deterministic latency (observed: anywhere from under 1s to several seconds, occasionally needing retries). Not tenant-related — every failure observed during diagnosis was a pure auth error, `wrongTenantResults` stayed `0` throughout. Operationally relevant for credential rotation: retry-with-backoff on first connection after rotation, don't assume instant consistency, and don't retry indefinitely (bounded retry + backoff + timeout — not implemented yet, intentionally, see "Deferred" below).
2. **Supabase project-level SSL enforcement is currently disabled** (`ssl-enforcement get` → `{"database": false}`). The Taply application connection itself already enforces TLS + the real CA (`rejectUnauthorized: true`, no bypass anywhere) — this is not a current app-level vulnerability. Enabling project-level enforcement is a deliberate **pre-production** checklist item (see below), not done now because it can interrupt DB connectivity.
3. **Performance findings, deliberately deferred** (Supabase Performance Advisor, not security):
   - 6 unindexed composite FKs (`memberships` ×3, `program_rule_versions` ×1, `public_enrollment_links` ×2).
   - 12 `auth_rls_initplan` warnings (`current_setting()` re-evaluated per row instead of `(select current_setting())`).
   - 9 unused indexes — expected, staging has 0 rows and no query traffic yet.

None of the above are called security failures. They are evidence-gated future work.

## Runtime hardening added after certification (this document's own phase)

- `backend/db/pool.ts`: `connectionTimeoutMillis` wired from `DATABASE_CONNECTION_TIMEOUT_MS` (bounded 100–60,000 ms, default 5,000 ms — see `backend/core/config.ts` for the justification); `pool.on('error', ...)` handler logging `db.pool.error` through the existing redaction pipeline, never crashing the process, never logging secret material.
- `backend/db/tenant-context.ts`: a connection whose `ROLLBACK` itself fails is discarded (`client.release(error)`) instead of returned to the pool as healthy; the original application/database error is always what propagates, never replaced by the rollback failure (only logged as `db.transaction.rollback_failed`).
- `scripts/certification/db-runtime-reliability.ts`: a permanent, secret-free, staging-only harness proving (a) the real pool works, is reused correctly, and leaves no residual tenant context; (b) a connection attempt to a reserved test address times out within the configured bound, without ever touching Supabase's own infrastructure; (c) the real application pool remains usable afterward. It does **not** prove a healthy connection dying mid-transaction (stale socket) — no safe way exists to induce that against real Supavisor without touching Supabase's infrastructure, which is forbidden. That specific scenario is recorded as **UNKNOWN**, not faked as PASS.

## Deferred (explicitly, evidence-gated)

- `statement_timeout` / `lock_timeout` / `idle_in_transaction_session_timeout` / `transaction_timeout` — not added. No production workload or query-latency distribution exists yet to size them against. Next tuning layer, once real routes and real traffic exist.
- `pool.max` increase beyond `1` — not done. Dynamic certification proved `max: 1` **safe** under 50 concurrent transactions (zero cross-tenant leakage), not that it's throughput-optimal. Future experiment path: `1 → 2 → 4`, measured against real application load, only once real routes exist.
- Bounded retry+backoff for credential rotation — not implemented. The non-deterministic propagation finding (#1 above) is documented; building the retry logic is deferred until real credential-rotation tooling is built.
- Enabling Supabase project-level SSL enforcement — deferred to a dedicated maintenance/hardening operation, pre-production, because it can restart or interrupt DB connectivity. Checklist before enabling: verify all Taply clients already use TLS (they do, today), verify migrations/CLI behavior under enforcement, verify the pooler, verify monitoring, schedule an explicit rollout window.
- The 6 unindexed FKs / 12 `auth_rls_initplan` warnings / 9 unused indexes — performance tuning, explicitly not touched in a security/reliability certification pass. See `pg_stat_statements` → `EXPLAIN ANALYZE` → proposed index → benchmark → proof, once real query patterns exist.

## PHASE 2B FREEZE = PASS

Database semantic changes — migrations, RLS policies, grants, roles, FK structure, TenantContext semantics, idempotency semantics, public-lookup semantics, pool `max` — **require reopening certification**. This document records the state certified, not a permanent guarantee that survives a schema change made without re-running the suite above.
