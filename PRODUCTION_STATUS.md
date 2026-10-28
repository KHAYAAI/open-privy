# OpenPrivy — Production Status (source of truth)

**Last updated:** 2026-10-28

This document supersedes the earlier self-certified files
(`PRODUCTION_READY_SUMMARY.md`, `AUDIT_REPORT_SIMULATION.md`,
`PRODUCTION_LAUNCH_CHECKLIST.md`, `README_PRODUCTION.md`). Those were written by
the same pass that generated the code and asserted "audited / production-ready"
with no independent verification. Where they conflict with this file, this file
is correct. Treat them as aspirational drafts, not status.

Everything below was verified by actually running it (Node 20/22, a real
PostgreSQL 16, and Redis). Claims are labelled ✅ verified, 🟡 partial, or
❌ not done.

## Backend application

| Area | Status | Evidence |
|---|---|---|
| Compiles | ✅ | `npm run build` clean (was 435 TS errors before) |
| Lint | ✅ | `npm run lint` 0 errors |
| Unit/correctness/security tests | ✅ | 99 backend tests (11 suites), 12 contract tests, 8 web tests, 9 mobile tests, all passing |
| Boots in production mode | ✅ | `NODE_ENV=production` against RDS-shaped Postgres |
| Custodial wallet create → encrypt at rest | ✅ | HTTP e2e; key stored `iv:tag:ciphertext`, not plaintext |
| Custodial send (decrypt→sign→broadcast) | ✅ (code) / 🟡 (chain) | crypto round-trip tested; live send needs funded key |
| Auth guard | ✅ | unauthenticated → 401 |
| WorkOS AuthKit SSO (header + cookie) | ✅ | `/auth/workos/authorize` returns valid AuthKit URL; `/auth/me` via Bearer AND `op_session` cookie; tampered cookie → 401 |
| JWT secret fail-closed | ✅ | no dev fallback in production |
| Rate limiting (Redis, global, env-tunable) | ✅ | 429 after limit; `rl:*` keys in Redis; limits configurable via env |
| DB schema via migrations (no synchronize in prod) | ✅ | 5 migrations apply on a fresh DB; regenerate shows no drift |
| Backup / restore (DR round-trip) | ✅ | `db-backup.sh`→`db-restore.sh` verified: row counts match, ciphertext intact |
| Load baseline (single instance) | ✅ | ~3.3k req/s `/health`, ~1.1k req/s `/auth/me` (JWT+DB); see test/load/RESULTS.md |
| Recovery drill (kill + restart, re-supplied key) | ✅ | automated, in CI on every push — kills the server with SIGKILL, restarts with the same master key, proves decrypt+sign recovers the correct address via the real production code path; negative control (wrong key) proves it's not vacuous. `.github/workflows/recovery-drill.yml` |
| Sanctions/OFAC screening on custodial sends | ✅ | DB-backed, fails closed if never-synced or stale; wired into both the custodial send and client-signed broadcast paths; proven over real HTTP against a live server (sanctioned address → 403 with reason; clean address → passes screening). Real OFAC schema **not yet confirmed live** — this sandbox can't reach treasury.gov; verify column names against the live file before relying on it. See `docs/SECURITY_AUDIT_BRIEF.md` |
| HSM-backed signing (opt-in, per wallet) | ✅ | Non-extractable secp256k1 key generated on a real PKCS#11 token (SoftHSM2 here; CloudHSM/Luna/YubiHSM in prod — module path is the only thing that changes). Verified against the real token: key generation, low-S-normalized signing, correct recovery-id resolution, and `load()` round-trip — 6/6 tests passing (`test/security/hsm-signing-key.security.test.ts`). Proven end-to-end over real HTTP: created via `POST /wallet/create {"signingMode":"hsm"}`, DB confirmed to hold no plaintext key, and a real custodial send signed successfully (failed only at the network broadcast hop, same as the software-signing path — this sandbox can't reach external RPC). **Not yet run against physical HSM hardware** — only a software PKCS#11 implementation. |
| Encryption master key from Secrets Manager | 🟡 | code path wired (IRSA + ARN); needs a real AWS account to exercise |
| ERC-4337 / gasless transactions | ✅ (local chain) / 🟡 (public testnet) | Contracts rebuilt on the official `@account-abstraction/contracts` 0.7.0 (old ones targeted v0.6 and could never have validated). 12 contract tests against the **real EntryPoint v0.7**; plus an end-to-end test where the backend's `UserOpService` builds and signs a sponsored op that the EntryPoint executes on a local chain (account deploys, transfer lands, paymaster pays gas, second op on nonce 1). CI: `account-abstraction.yml`. Fixed on the way: sponsorship was applied after signing (invalidated every sponsored op), nonce read from the wrong contract, bundler RPC in the wrong format, and **gasless sends skipped sanctions screening**. Still to do: one run on Sepolia against Pimlico (needs network access). |
| Master-key rotation | ✅ | Zero-downtime: servers hold current + previous keys; `rotate-master-key.js` (dry run by default, `--apply` to write) verifies every wallet derives its own address before writing, is resumable and idempotent. Full rehearsal `npm run drill:rotation` in CI on every push: dry run writes nothing, live rotation while serving, old key retired, every wallet still signs, old key fails, a poisoned row is refused. Procedure: `docs/DR_RUNBOOK.md` Scenario D. Not yet run against a real Secrets Manager secret. |
| Supabase-backed auth end-to-end | ⚪ | superseded by WorkOS; removed from both apps |
| Cross-user authorization | ✅ | Two-user drill over real HTTP in CI (`npm run drill:authz`, 12 checks). Fixed: any user could list every user's recovery contacts with their verification tokens and delete them (wrong user field + TypeORM dropping `undefined` from queries); read others' wallet balances; set others' wallet recovery email. WorkOS login no longer links an existing account through an unverified email (account-takeover path). |
| CSRF on the browser session | ✅ | Cookie-authenticated writes require `X-CSRF-Token` (blocked cross-origin by CORS); covered by the drill |
| Social recovery (guardians) | ❌ disabled | Off unless `ENABLE_SOCIAL_RECOVERY=true`. The current design lets the account owner verify and approve their own guardians, needs a logged-in session (which a locked-out user lacks), and "complete" restores nothing. Needs a redesign before it is turned on. |
| Web app | ✅ | WorkOS sign-in with the httpOnly cookie (no token visible to scripts), working send flow with checksum/amount validation and a review step, strict CSP and security headers, patched Next.js 14.2. Verified in Chromium against the real backend: 17/17 checks. CI: `web.yml`. |
| Mobile app | 🟡 | WorkOS sign-in via PKCE one-time code, token only in Keychain/Keystore with an OS-enforced biometric lock, send flow with biometric confirmation. Type-checks, 9 unit tests, and bundles for iOS and Android (CI: `mobile.yml`). **Not yet run on a device**; icons are placeholders. |

## Infrastructure (AWS)

| Area | Status | Evidence |
|---|---|---|
| CloudFormation VPC + EKS | ✅ | `cfn-lint` clean (fixed circular SG, EKS logging, Nodegroup type) |
| CloudFormation RDS + Redis + Secrets + S3 | ✅ | `cfn-lint` clean (fixed invalid RDS props, Redis log config, S3 encryption, generated DB password) |
| k8s manifests (deploy, HPA, SA/IRSA, ingress, migrate job) | ✅ | all parse; security context + probes + anti-affinity present |
| Dockerfile | 🟡 | rewritten multi-stage, non-root, tini, healthcheck — **not** build-verified here (no Docker daemon in this env) |
| CI (`ci.yml`) and CD (`deploy-aws.yml`) | 🟡 | corrected to install/build/lint/test + run migrations before rollout; not executed here (needs AWS/GitHub) |

## The hard gates before real traffic

1. **External security audit** — custody, AA, auth. Independent third party. ❌ (external)
   Engagement brief ready to send: `docs/SECURITY_AUDIT_BRIEF.md` — scope,
   priority files, and known gaps, so audit time isn't spent rediscovering
   what we already know.
2. **Live testnet ERC-4337 transaction**. 🟡 Contracts rebuilt for EntryPoint
   v0.7 and proven against the real EntryPoint on a local chain, driven by the
   backend's own code (see table). Remaining: deploy factory + paymaster to
   Sepolia and send one sponsored op through Pimlico, from an environment with
   RPC access (e.g. the AWS staging cluster).
3. **Load test** on staging to size RDS/Redis/HPA. 🟡 local baseline captured
   (test/load/RESULTS.md); staging run + write-path (wallet create) still needed.
4. **Master-key rotation** tooling + dry-run. ✅ Tool built and rehearsed end to end in CI (see table). Do one real rotation on staging once it exists.
5. **DR drill** — RDS PITR + Multi-AZ failover + confirm decrypt. 🟡 logical
   backup/restore round-trip verified + runbook (`docs/DR_RUNBOOK.md`); now
   also an **automated** kill/restart drill running in CI on every push
   (`.github/workflows/recovery-drill.yml`), not just a one-time manual check.
   The RDS PITR + Multi-AZ failover legs specifically still need a real AWS account.
6. **Money-transmitter / VASP licensing** for the custodial model — legal, above
   SOC 2 / PCI. ❌ (counsel) Scoping memo ready to send: `docs/LICENSING_SCOPING_MEMO.md`
   — the custody fact pattern and the specific questions counsel needs to answer.

Deploy procedure: `docs/AWS_PRODUCTION_DEPLOY.md` · DR: `docs/DR_RUNBOOK.md`.

## WorkOS (auth) state

Project **OPEN PRIVY** (`project_01M0E4NNMZ0TBVBT2YVCXY4G14`):
- Staging org `org_01M0E4TBZMQ66B6KCPQWHX1ZFD` (client `client_01M0E4NP2BATG2MTE1707JV23Y`)
- Production org `org_01M0E4T889CBRY9XAN8ARNPAD2` (client `client_01M0E4NPFKM2J49B5HQAABH0CJ`)

Set `WORKOS_API_KEY` (sk_…) + the client id to go live; one browser login
exercises the code exchange (the only untested leg).

## Honest one-line summary

The backend is a **real, running, custodial embedded-wallet API** with
**WorkOS SSO**, **sanctions screening** (now on gasless sends too), an
**automated recovery drill**, **zero-downtime master-key rotation**, an
**optional HSM-backed signing path**, and **gasless ERC-4337 transactions
proven against the real EntryPoint v0.7**. All of it is proven by running it,
not asserted, on top of production-shaped AWS infrastructure that
lints/validates clean. The web and mobile apps now use the same
WorkOS sign-in and a working send flow, and a two-user authorization drill
runs in CI. It is **not yet launch-certified**: an external audit,
licensing, a staging deployment (with its load test, AWS failover drills and
one public-testnet gasless send), a device test of the mobile app, and a
redesign of social recovery (currently disabled) remain. This is
"deployable to staging for hardening", not "flip it live to the public".
