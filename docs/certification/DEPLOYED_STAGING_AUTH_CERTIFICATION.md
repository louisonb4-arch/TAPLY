# Deployed Staging Auth — Certification (frozen)

No secret in this document.

## Identity

- Stable staging origin: `https://taply-staging-louisondu44000-7822.vercel.app`
- Vercel Preview deployment ID: `dpl_9xtyYCcJdqXsaYMNrJU4zfVnDiw1`
- Vercel project: `louisondu44000-7822/taply` (`prj_DgZWupo9g7tlUImeBqEFkQK5QVNm`)
- Git HEAD used for this deployment: `dede3535077b67c196912cf16c89dfa8a1116d6e`
- Migrations: 13 local / 13 remote
- Production: untouched (no Production env var, no Production deployment, `ssoProtection` setting unchanged)
- Git push: not part of this certification
- Security Advisor after this certification: 0 findings

## Final verdict

**DEPLOYED STAGING AUTH CERTIFICATION = PASS**

This verdict was obtained against the real public internet path: real HTTPS requests from an external client to the deployed Vercel Preview origin, real Supabase Auth users, real Supavisor Transaction Pooler, real PostgreSQL RLS, CA-verified TLS, the real deployed application code (no local Hono import, no direct `backend/auth/*` import for the main proof), real concurrent A/B sessions, and complete cleanup after certification.

## Certified properties

| Property | Result |
|---|---|
| Deployed `/api/health` | 200 |
| Deployed login, Merchant A | PASS |
| Deployed login, Merchant B | PASS |
| Secure cookie (`__Host-taply_session`, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain) | PASS |
| A/B cookies differ | PASS |
| Deployed `/api/auth/me` A → A | PASS |
| Deployed `/api/auth/me` B → B | PASS |
| Cache-Control: no-store | PASS |
| Supabase tokens exposed to browser | NONE |
| Exact Origin (deployed) | ALLOWED |
| Missing Origin (deployed) | REJECTED |
| `https://evil.example` Origin (deployed) | REJECTED |
| Production origin (`taply-theta.vercel.app`) sent as Origin to staging route | REJECTED |
| Disabled mapping blocks existing session | PASS |
| Disabled mapping blocks new login generically | PASS |
| Deployed logout | PASS (200, no 500, no RLS error) |
| Second deployed logout | PASS / idempotent |
| Logout A affects B | NO |
| Bad-password generic error | PASS (401 AUTH_INVALID, same shape as disabled-mapping login) |
| DB session → merchant mapping (A→A only, B→B only) | PASS |
| Vercel function log secret scan | 0 matches |
| Certification fixtures after cleanup | 0 |
| Certification Auth users after cleanup | 0 |
| Structural drift | NONE |

## DB session mapping evidence

Read-only inspection confirmed exactly 2 real session rows during the certification window (one per certification merchant), each with the correct `merchant_id`/`merchant_user_id`/`auth_user_id` triple and no cross-tenant mapping. No token hash or raw token value was exposed in any inspection output.

## Vercel log secret scan

Real function logs for the certified deployment were pulled via `vercel logs --json` and scanned (boolean/count assertions only, no candidate value ever printed) for: certification password A, certification password B, raw Taply cookie A, raw Taply cookie B, the literal strings `access_token`/`refresh_token`, any JWT-shaped (`eyJ...`) value, and any `postgresql://...@` connection string with an embedded credential. **0 matches** across all categories.

## Standing `taply_app` staging credential

Unlike every prior certification fixture in this project, the `taply_app` password used by this deployment is **intentionally persistent** — it is the real runtime credential embedded in `DATABASE_URL_APP` for the Vercel Preview environment, not a temporary certification password. It was deliberately **not** nulled after this certification.

This is an operational posture change from every earlier mission in this project (where `taply_app` was always nulled immediately after use): a deployed staging runtime necessarily requires a standing database credential. This does not change RLS, role, or grant semantics — only the credential's lifecycle.

**This credential must be rotated only through a controlled, deliberate credential-rotation procedure** (generate new password → update `DATABASE_URL_APP` in Vercel → verify → redeploy/confirm → only then retire the old password) — never nulled casually, and never nulled as a routine "cleanup" step the way certification fixtures are.

## Deployment protection

The stable staging alias (`taply-staging-louisondu44000-7822.vercel.app`) was registered as a project domain, making it eligible for the project's existing `ssoProtection.deploymentType = "all_except_custom_domains"` exemption. No new protection-bypass secret was created. Other (non-aliased) Preview deployment URLs remain protected (`302` to Vercel authentication) — the exemption is scoped to this one domain only, not global.

## Known incident — `VERCEL_OIDC_TOKEN` exposure

During the Vercel environment-configuration mission, `cat`-ing a `vercel env pull` output file unexpectedly printed a real Vercel-issued `VERCEL_OIDC_TOKEN` (a short-lived JWT, auto-written by the Vercel CLI, not one of the 5 target application secrets) into the conversation transcript.

This token is classified **exposed until its own expiry** — not expired, not assumed safe, regardless of elapsed time, unless independently re-verified against its `exp` claim at the time of reading this document. It grants no access to Supabase or to any of the 5 real application secrets (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL_APP`, `DATABASE_CA_CERT`, `APP_ORIGIN`); it is scoped to this Vercel project's own OIDC federation audience. It was never committed to git, never staged, and was deleted from local disk immediately after the incident. It must never be printed or reused. No Supabase/DB credential rotation was performed as a result of this incident, based on the evidence available at the time (the token does not grant access to those credentials).

## Trust boundaries (unchanged from Merchant Auth V1 staging certification)

See `docs/certification/MERCHANT_AUTH_V1_STAGING_CERTIFICATION.md` — this certification exercises the same frozen Auth invariants over the real public deployment path rather than a local/direct-code path. No Auth invariant was changed by this mission.

## Pre-production blockers still open

This certification proves the deployed Preview runtime, not production readiness. All blockers listed in `docs/certification/MERCHANT_AUTH_V1_STAGING_CERTIFICATION.md` remain open, plus:

- Production has no environment variables and no Auth-capable deployment — this certification deliberately did not touch Production.
- The standing `taply_app` staging credential needs a documented rotation procedure before any production equivalent is created.

## Freeze

**DEPLOYED STAGING AUTH FREEZE = PASS**

Staging evidence is now complete both for the local/direct Auth code path (Merchant Auth V1 staging certification) and for the deployed public Vercel Preview path (this document). Production remains uncertified and undeployed.
