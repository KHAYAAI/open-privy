# OpenPrivy — Custodial Embedded Wallet Platform

Embedded crypto wallets with no seed phrases: users log in with email/social/SSO,
get a wallet, and transact — the platform generates, encrypts, and signs on
their behalf. Multi-chain (Ethereum, Polygon, Solana), gas-sponsored via
ERC-4337 account abstraction.

**Version:** 0.1.0
**Status:** 🟡 Pre-launch. Backend, contracts, web and mobile apps build and
pass 128 tests, and four automated drills run in CI; **not yet cleared for
real user funds**. See [Launch readiness](#launch-readiness) below
and `PRODUCTION_STATUS.md` for the full, evidence-backed ledger.

This README describes what the code does. It does not claim things that
haven't been verified — where something is unproven, it says so.

## What this actually is

OpenPrivy is **custodial**: the backend holds the only copy of each user's
private key (encrypted) and signs on their behalf. That's the trade-off behind
"no seed phrases" — convenience for the user, custody obligations for the
platform. See [Compliance](#compliance--licensing) before treating this as
launch-ready for real funds.

## Architecture

```
Web (Next.js) / Mobile (Expo)
        │  HTTPS
        ▼
ALB — TLS termination (ACM)
        │
        ▼
EKS — NestJS backend, 3–10 pods (HPA)
   modules: auth · wallet · blockchain · transactions
            · account-abstraction · compliance · defi · monitoring
            · social-recovery (disabled pending redesign)
        │
        ├──► RDS PostgreSQL 16 (Multi-AZ, schema via migrations)
        ├──► ElastiCache Redis (global rate limiting)
        ├──► Secrets Manager (DB password, encryption master key — read via IRSA)
        ├──► WorkOS AuthKit (SSO / email / MFA)
        └──► Chain RPC (Alchemy) + Bundler/EntryPoint (Pimlico)
```

**Custody path:** a wallet's private key is generated server-side, encrypted
with AES-256-GCM using a key derived per-user (PBKDF2, 100k iterations) from a
master key held in AWS Secrets Manager. Exactly one function,
`WalletService.getEvmSigner`, ever decrypts a key — after verifying the caller
owns that wallet — and it signs and broadcasts immediately. The plaintext key
never persists and is never returned over the API.

## Tech stack

| Layer | Technology |
|---|---|
| Web | Next.js + React |
| Mobile | Expo (React Native) |
| Backend | NestJS + TypeORM |
| Database | PostgreSQL 16 (RDS Multi-AZ) |
| Cache / rate limiting | Redis (ElastiCache) |
| Auth | WorkOS AuthKit (SSO, social, email, MFA): httpOnly cookie on web, PKCE one-time code on mobile |
| Blockchain | ethers.js + Alchemy (EVM), @solana/web3.js |
| Account abstraction | ERC-4337 (EntryPoint v0.7) + Pimlico bundler/paymaster |
| Secrets | AWS Secrets Manager, read via pod IRSA role |
| Monitoring | Prometheus (`/metrics`) |
| Infra | CloudFormation (VPC/EKS, RDS/Redis/Secrets/S3) + Kubernetes + Docker |

## Quick start (local)

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 16 (via `docker-compose up -d`, or your own instance)

### Setup

```bash
git clone https://github.com/khayaai/open-privy.git
cd open-privy

cp .env.example .env
# fill in: ENCRYPTION_MASTER_KEY, JWT_SECRET, DATABASE_URL,
# WORKOS_API_KEY and WORKOS_CLIENT_ID (see below)

docker-compose up -d          # Postgres + Redis

cd services/backend
npm install --legacy-peer-deps
npm run migration:run         # applies committed migrations — never `synchronize` outside dev
npm run build
npm run dev                   # http://localhost:3001
```

```bash
cd apps/web
npm install --legacy-peer-deps
npm run dev                   # http://localhost:3000 (signs in through WorkOS via the backend)
```

```bash
cd apps/mobile
npm install --legacy-peer-deps
npx expo start                # sign-in needs a dev/preview build (openprivy:// scheme), not Expo Go
```

Verify: `curl http://localhost:3001/health` → `{"status":"ok",...}`

### Required environment variables

```bash
# Security — REQUIRED, the app refuses to boot without these in production
ENCRYPTION_MASTER_KEY=$(openssl rand -base64 32)   # or ENCRYPTION_MASTER_KEY_SECRET_ARN in prod
JWT_SECRET=$(openssl rand -base64 48)

# Database
DATABASE_URL=postgresql://app:dev-only@localhost:5432/openprivy

# Auth (WorkOS AuthKit: SSO, social, email, MFA)
WORKOS_API_KEY=sk_test_...
WORKOS_CLIENT_ID=client_...
WORKOS_REDIRECT_URI=http://localhost:3001/auth/workos/callback
WORKOS_POST_LOGIN_REDIRECT=http://localhost:3000/dashboard
CORS_ORIGINS=http://localhost:3000   # the web app's origin, exactly

# Blockchain RPC
ETHEREUM_RPC_SEPOLIA=https://sepolia.infura.io/v3/YOUR_KEY
ALCHEMY_API_KEY=your-alchemy-key

# Optional: gas sponsorship
PIMLICO_API_KEY=your-pimlico-key
```

Full list with comments: `.env.example`.

## Project structure

```
openprivy/
├── apps/
│   ├── web/                        # Next.js frontend
│   └── mobile/                     # Expo app
│
├── services/
│   ├── backend/                    # NestJS API
│   │   ├── src/
│   │   │   ├── modules/            # auth, wallet, blockchain, transactions,
│   │   │   │                       # account-abstraction, defi, social-recovery,
│   │   │   │                       # monitoring
│   │   │   ├── common/             # encryption, middleware, logging
│   │   │   ├── config/             # typeorm, jwt, secrets
│   │   │   ├── migrations/         # committed schema migrations
│   │   │   └── data-source.ts      # TypeORM CLI datasource
│   │   └── test/                   # security/, correctness/, integration/, e2e/
│   │
│   └── contracts/                  # SimpleAccount, Factory, Paymaster (ERC-4337)
│
├── aws/                             # CloudFormation: VPC/EKS, RDS/Redis/Secrets/S3
├── k8s/                             # Deployment, HPA, migrate Job, ALB Ingress
├── scripts/                         # db-backup.sh, db-restore.sh, deploy scripts
├── test/load/                       # load test harness + measured results
│
├── docs/
│   ├── AWS_PRODUCTION_DEPLOY.md    # ordered deploy runbook
│   └── DR_RUNBOOK.md               # disaster recovery scenarios & drill checklist
│
├── PRODUCTION_STATUS.md            # source of truth: verified / partial / blocked
└── docker-compose.yml               # local Postgres + Redis
```

## API endpoints

### Auth
```
GET    /auth/workos/authorize        # web: returns the AuthKit hosted-login URL
GET    /auth/workos/callback         # OAuth callback; web gets an httpOnly cookie, mobile a one-time code
POST   /auth/workos/mobile/start     # mobile: PKCE challenge in, AuthKit URL out
POST   /auth/workos/mobile/exchange  # mobile: one-time code + PKCE verifier -> session token
GET    /auth/me
POST   /auth/logout
POST   /auth/signup, /auth/login     # legacy email/password; the apps no longer use these
```

Cookie-authenticated writes must send an `X-CSRF-Token` header (any value);
other origins cannot add it past CORS. Bearer-token clients are unaffected.

### Wallet
```
POST   /wallet/create                    # generates + encrypts a key, returns no key material
                                          #   body: { chain, signingMode?: "software"|"hsm" }
GET    /wallet/get
GET    /wallet/list
GET    /wallet/:walletId/balance
POST   /wallet/:walletId/recovery-email
```

### Transactions
```
POST   /transactions/send                # custodial: decrypt → sign → broadcast
POST   /transactions/request             # client-signing flow: create a signing request
POST   /transactions/:txId/confirm       # broadcast a client-signed tx
GET    /transactions/history
GET    /transactions/:txId
```

### Account abstraction (ERC-4337)
```
POST   /account-abstraction/build-userop
POST   /account-abstraction/send-userop
GET    /account-abstraction/userop-status/:userOpHash
GET    /account-abstraction/paymaster/status
GET    /account-abstraction/paymaster/balance
POST   /account-abstraction/estimate-gas
```

### Blockchain
```
GET    /blockchain/balance/:address
GET    /blockchain/gas-price
GET    /blockchain/tx-history/:address
GET    /blockchain/tx-receipt/:txHash
GET    /blockchain/solana/balance/:address
GET    /blockchain/polygon/balance/:address
GET    /blockchain/supported-chains
```

### Social recovery (disabled)
Off unless `ENABLE_SOCIAL_RECOVERY=true`; the routes return 404 otherwise. The
current guardian design lets an account owner approve their own guardians and
does not restore access, so it needs a redesign before it is turned on.

### DeFi
```
GET    /defi/swap/quote
POST   /defi/swap/build
GET    /defi/stake/info
POST   /defi/stake/build
```

### Ops
```
GET    /health                       # liveness/readiness
GET    /metrics                      # Prometheus scrape endpoint
GET    /metrics/info                 # human-readable process info
GET    /compliance/sanctions/status  # sanctions list sync state (read-only)
```

Sanctions screening against an OFAC-SDN-style list runs on every custodial
send and fails closed if the list has never synced or is stale (default max
age 7 days). The sync itself is a scheduled k8s CronJob, not an HTTP route —
see `k8s/sanctions-sync-cronjob.yaml`.

## Database schema (current)

**users** — `id` (uuid PK), `email` (unique), `workosUserId` (unique, nullable —
links a WorkOS identity to this account), `username`, `avatarUrl`,
`emailVerified`, `mfaEnabled`, `createdAt`/`updatedAt`

**wallets** — `id` (uuid PK), `userId` (FK), `address` (unique), `chain`
(`ethereum`/`solana`/`polygon`), `publicKey`, `encryptedPrivateKey`
(`iv:authTag:ciphertext`, AES-256-GCM — null for HSM-mode wallets),
`encryptionKeyId` (non-secret id of the master key that encrypted it, used by
rotation), `signingMode` (`software`/`hsm`), `hsmKeyLabel` (null unless
HSM-mode), `recoveryEmail`, `isActive`

**transactions** — `id` (uuid PK), `userId`/`walletId` (FK), `chain`, `txHash`,
`fromAddress`, `toAddress`, `amount`, `status`, `metadata` (jsonb)

**recovery_contacts** / **recovery_guardians** — guardian contacts and their
approval state for M-of-N social recovery

**audit_logs** — `userId`, `eventType`, `metadata`, `timestamp`

Schema is applied via committed TypeORM migrations
(`npm run migration:run`) — production never uses `synchronize`.

## Security

What's implemented and verified:
- Private keys encrypted at rest, **AES-256-GCM** with per-user PBKDF2-derived
  keys (not a single shared key)
- Master key sourced from **AWS Secrets Manager** in production, read via the
  pod's IRSA role — never in a manifest
- **Fail-closed JWT secret** — refuses to boot on a default/dev secret when
  `NODE_ENV=production`
- **Redis-backed rate limiting**, global across replicas, env-tunable limits
- CORS restricted to configured origins; `helmet` security headers
- Schema via reviewed migrations, not runtime `synchronize`
- **Sanctions/OFAC screening** on every custodial send, fails closed if the
  list has never synced or is stale
- **Automated recovery drill in CI** — kills the server, restarts it with a
  re-supplied key, and proves signing still recovers the correct address
  (plus a negative control, so the drill can't pass vacuously)
- **Optional HSM-backed signing** (`signingMode: "hsm"`) — the key is
  generated non-extractable on a PKCS#11 token and never exists as plaintext
  anywhere, verified against a real token (SoftHSM2 locally; CloudHSM/Luna/
  YubiHSM in production use the same code path)
- **Zero-downtime master-key rotation**, rehearsed end to end in CI
- **Cross-user authorization drill in CI**: two users over real HTTP; neither
  can read or change the other's wallets or recovery data
- **WorkOS account linking requires a verified email** (closes an
  account-takeover path); **CSRF protection** on the browser session
- **Gasless transactions screened for sanctions** too, including ERC-20
  recipients; unreadable call data is refused
- **Web app**: session in an httpOnly cookie (no token visible to scripts),
  strict Content-Security-Policy and security headers, patched Next.js
- **Mobile app**: PKCE one-time-code sign-in (no token in URLs), token only in
  the iOS Keychain / Android Keystore, OS-enforced biometric lock, biometric
  confirmation before sends, Android backups disabled

What's explicitly **not** done yet — see [Launch readiness](#launch-readiness):
- No independent security audit
- Gasless (ERC-4337) transactions are proven against the real EntryPoint v0.7
  on a local chain, but not yet sent through a public bundler on Sepolia
- Master-key rotation is built and rehearsed in CI, but not yet run against a
  real Secrets Manager secret
- HSM signing not yet exercised against physical hardware, only SoftHSM2
- Mobile app not yet run on a device (it type-checks, is tested, and bundles
  for iOS and Android); icons are placeholders
- Social recovery disabled pending a redesign
- No money-transmitter / VASP licensing review for the custodial model

## Testing

```bash
cd services/backend
npm run test               # unit + correctness + security (99 passing, 11 suites)
npm run test:security      # encryption, key rotation, auth, sanctions, HSM signing tests
npm run test:correctness   # UserOp construction, sponsorship order, AA screening, custody round-trip
npm run test:e2e           # requires a running DB
npm run lint
```

HSM-signing tests run against a real PKCS#11 token (SoftHSM2) if one is
present at the standard install path, and skip cleanly otherwise.

Drills (real Postgres + the real server; both run in CI on every push):
- `npm run drill:recovery`: kill the server, restart, prove wallets still sign
- `npm run drill:rotation`: full master-key rotation rehearsal (`docs/DR_RUNBOOK.md`, Scenario D)
- `npm run drill:authz`: two users over real HTTP; neither can touch the other's data; CSRF rule

Apps: `cd apps/web && npx jest && npx next build`; `cd apps/mobile && npx jest && npx tsc --noEmit`.

Deploying a staging environment: **`docs/AWS_BEGINNER_GUIDE.md`** (step by step, written for a first-time AWS user).

Contracts and gasless transactions (`services/contracts`):
```bash
npx hardhat test           # 12 tests against the real EntryPoint v0.7
npm run test:aa-e2e        # backend builds + signs a sponsored UserOp; a local EntryPoint executes it
```

Load testing: `test/load/quick-load.sh` (autocannon) and `test/load/staging-load.k6.js`
(k6 ramp). Measured single-instance baseline in `test/load/RESULTS.md`.

## Deployment

### Local
```bash
docker-compose up
```

### AWS (staging/production)

- **First time on AWS? Start here:** `docs/AWS_BEGINNER_GUIDE.md`. A
  phase-by-phase walkthrough from an empty account to a running staging
  backend, the web app on Amplify, the mobile build, and the launch-gate
  checks, with a check after every phase and a teardown at the end.
- Condensed runbook for experienced operators: `docs/AWS_PRODUCTION_DEPLOY.md`.

The CloudFormation templates pass `cfn-lint`, and the web and mobile builds
are verified. The backend Docker image and the CD pipeline have not yet been
run end to end; the first staging deploy does that.

### Disaster recovery
`docs/DR_RUNBOOK.md` — RPO ≤5 min / RTO ≤60 min targets, failure scenarios, and
a quarterly drill checklist. `scripts/db-backup.sh` / `scripts/db-restore.sh`
have been round-trip tested: identical row counts and intact encrypted key
data after a restore into a fresh database.

## Monitoring

```bash
curl http://localhost:3001/health        # liveness/readiness
curl http://localhost:3001/metrics       # Prometheus exposition format
```

Measured local baseline (single instance): ~3,290 req/s on `/health`,
~1,120 req/s on `/auth/me` (full JWT verify + Postgres read). Details and
reproduction steps in `test/load/RESULTS.md`.

## Launch readiness

Six gates stand between this repository and real user funds. The full ledger
with evidence is in **`PRODUCTION_STATUS.md`**.

| # | Gate | Status | What closes it |
|---|---|---|---|
| 1 | External security audit | Open | Send `docs/SECURITY_AUDIT_BRIEF.md` to audit firms; closes when the final report has no unresolved critical/high findings |
| 2 | Live ERC-4337 transaction | Partial | Proven against the real EntryPoint v0.7 on a local chain (CI). Closes with one sponsored send on Sepolia via Pimlico, from staging (guide Phase 12d) |
| 3 | Staging load test | Partial | Local baseline captured. Closes with a k6 run against staging that meets the targets (guide Phase 12c) |
| 4 | Master-key rotation | **Closed** | Zero-downtime tool + full rehearsal in CI. Optional: one real rotation on staging |
| 5 | Disaster recovery on AWS | Partial | Backup/restore and kill-restart drills verified. Closes with a Multi-AZ failover and a point-in-time restore on staging within RPO ≤5 min / RTO ≤60 min (guide Phases 12a–b) |
| 6 | Money-transmitter / VASP licensing | Open | Send `docs/LICENSING_SCOPING_MEMO.md` to counsel per launch jurisdiction; closes with a written opinion and licences, or a licensed-partner structure |

**Road to launch**
1. **Now, in parallel:** send the audit brief and the licensing memo. Both run on their own clock.
2. **Staging:** follow `docs/AWS_BEGINNER_GUIDE.md`, then run Phase 12 (load test, failover, restore, Sepolia send). This closes gates 2, 3 and 5.
3. **Then:** test the mobile app on devices, redesign social recovery, fix audit findings, and open to real traffic.

## Compliance & licensing

**SOC 2** — Type II (what enterprise buyers ask for) is realistically 4–6
months of evidence once controls are in place. Encryption, Secrets Manager,
IRSA least-privilege, and WorkOS's audit-log streaming already feed that
evidence base; formal access reviews, incident-response runbooks, and vendor
management do not exist yet.

**PCI DSS** — only applies if a fiat card on/off-ramp is added. If so, route
through a tokenizing processor and stay in SAQ-A scope; do not handle raw card
data directly.

**Money-transmitter / VASP licensing** — holding user private keys is a
custodial model, and custody of this kind can trigger licensing and BSA/AML/KYC
obligations depending on jurisdiction. This is a legal question for counsel,
independent of SOC 2 or PCI, and should be resolved before public launch.

## Development commands

```bash
npm run dev              # all services (turbo)
npm run build
npm run test
npm run lint
npm run format

cd services/backend && npm run dev     # backend only
cd apps/web && npm run dev             # web only
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Open a Pull Request

Please be respectful and constructive — this is a community project.

## License

No `LICENSE` file is committed yet, despite this repo previously claiming MIT —
that claim wasn't backed by an actual file. Add one (and a `license` field in
`package.json`) before treating this as open source or accepting outside
contributions.

## Further reading

- `PRODUCTION_STATUS.md` — verified / partial / blocked, with evidence for each
- `docs/AWS_BEGINNER_GUIDE.md` — step-by-step staging deployment for a first-time AWS user
- `docs/AWS_PRODUCTION_DEPLOY.md` — condensed AWS deployment runbook
- `docs/DR_RUNBOOK.md` — disaster recovery scenarios and drill checklist
- `docs/SECURITY_AUDIT_BRIEF.md` — ready-to-send engagement brief for an independent audit
- `docs/LICENSING_SCOPING_MEMO.md` — ready-to-send scoping memo for counsel on custodial licensing
- `test/load/RESULTS.md` — measured load-test baseline
