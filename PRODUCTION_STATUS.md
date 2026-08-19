# OpenPrivy — Production Status (source of truth)

**Last updated:** 2026-08-19

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
| Unit/correctness/security tests | ✅ | 32 passing, 1 skipped (testnet integration) |
| Boots in production mode | ✅ | `NODE_ENV=production` against RDS-shaped Postgres |
| Custodial wallet create → encrypt at rest | ✅ | HTTP e2e; key stored `iv:tag:ciphertext`, not plaintext |
| Custodial send (decrypt→sign→broadcast) | ✅ (code) / 🟡 (chain) | crypto round-trip tested; live send needs funded key |
| Auth guard | ✅ | unauthenticated → 401 |
| JWT secret fail-closed | ✅ | no dev fallback in production |
| Rate limiting (Redis, global) | ✅ | 429 after 5 logins/min; `rl:*` keys in Redis |
| DB schema via migrations (no synchronize in prod) | ✅ | migration applies all 7 tables on a fresh DB |
| Encryption master key from Secrets Manager | 🟡 | code path wired (IRSA + ARN); needs a real AWS account to exercise |
| ERC-4337 / account abstraction end-to-end | ❌ | hash is v0.7-spec-shaped but unproven on a live EntryPoint; `SimpleAccount.sol` nonce model still needs reconciling |
| Supabase-backed auth end-to-end | ❌ | booted with dummy Supabase config |

## Infrastructure (AWS)

| Area | Status | Evidence |
|---|---|---|
| CloudFormation VPC + EKS | ✅ | `cfn-lint` clean (fixed circular SG, EKS logging, Nodegroup type) |
| CloudFormation RDS + Redis + Secrets + S3 | ✅ | `cfn-lint` clean (fixed invalid RDS props, Redis log config, S3 encryption, generated DB password) |
| k8s manifests (deploy, HPA, SA/IRSA, ingress, migrate job) | ✅ | all parse; security context + probes + anti-affinity present |
| Dockerfile | 🟡 | rewritten multi-stage, non-root, tini, healthcheck — **not** build-verified here (no Docker daemon in this env) |
| CI (`ci.yml`) and CD (`deploy-aws.yml`) | 🟡 | corrected to install/build/lint/test + run migrations before rollout; not executed here (needs AWS/GitHub) |

## The hard gates before real traffic (none self-certifiable)

1. **External security audit** — custody, AA, auth. Independent third party.
2. **Live testnet ERC-4337 transaction** that lands (no `SIG_VALIDATION_FAILED`).
3. **Supabase auth** exercised end-to-end.
4. **Load test** on staging to size RDS/Redis/HPA.
5. **Master-key rotation** tooling + dry-run.
6. **DR drill** — RDS snapshot restore, Multi-AZ failover, confirm decrypt.

Deploy procedure: `docs/AWS_PRODUCTION_DEPLOY.md`.

## Honest one-line summary

The backend is now a **real, running, custodial embedded-wallet API** with
production-shaped AWS infrastructure that lints/validates clean. It is **not yet
launch-certified**: the account-abstraction path, Supabase auth, an external
audit, load testing, and DR drills remain. This is "deployable to a staging
environment for hardening", not "flip it live to the public".
