# OpenPrivy — Security Audit Engagement Brief

**Purpose of this document:** ready to send to an independent security firm to
scope a real audit. It states plainly what OpenPrivy is, what the custody model
actually does, where to look first, and what is already known to be
incomplete — so audit time isn't spent rediscovering things we already know.

## 1. What we're asking to be audited

OpenPrivy is a **custodial embedded-wallet platform**: the backend generates a
private key on a user's behalf, encrypts it, and signs transactions for the
user when authorized. Users never see a seed phrase. This is a NestJS backend
on AWS (EKS/RDS/Redis/Secrets Manager), plus a set of ERC-4337 smart contracts.

We are asking for a **manual security review focused on the custody model and
the paths that touch key material or funds**, not a general code-quality
review.

## 2. The custody mechanism, precisely

A wallet's private key is:
1. Generated server-side at wallet creation (`ethers.Wallet.createRandom()` for
   EVM, `Keypair.generate()` for Solana).
2. Encrypted with **AES-256-GCM** using a key derived **per user** via
   **PBKDF2** (100,000 iterations, SHA-256) from a single master key.
3. The master key is held in **AWS Secrets Manager**; in production the
   backend pod reads it at boot via its own IAM role (IRSA) — it is never in
   an environment variable checked into a manifest.
4. Stored as `iv:authTag:ciphertext` in Postgres (`wallets.encryptedPrivateKey`).
5. Decrypted in exactly **one** code path,
   `WalletService.getEvmSigner` → `getDecryptedPrivateKey`, which verifies the
   caller owns the wallet, decrypts, signs, and the resulting `ethers.Wallet`
   instance is used immediately to broadcast. Plaintext key material is never
   logged, returned over the API, or persisted outside that call's stack frame.

Key rotation exists as a primitive (`EncryptionService.rotateKey`) but there is
**no batch tool or rehearsed drill yet** to re-encrypt all wallets if the
master key is ever rotated or suspected compromised — flag this explicitly if
it's in scope.

## 3. Priority order for review

1. **`services/backend/src/common/encryption/encryption.service.ts`** and
   **`master-key.loader.ts`** — the encryption primitive and master-key
   resolution (env var locally, Secrets Manager in production).
2. **`services/backend/src/modules/wallet/wallet.service.ts`** — the only
   decrypt path; ownership checks; whether any other path could be induced to
   leak key material (error messages, logs, serialization).
3. **`services/backend/src/modules/transactions/transaction.service.ts`** —
   the custodial send path: decrypt → sign → broadcast, and whether an
   authenticated user could ever trigger a signature over a wallet they don't
   own.
4. **`services/backend/src/modules/account-abstraction/`** — ERC-4337
   `userOpHash` construction (rewritten to bind all EntryPoint v0.7 fields;
   **not yet verified on-chain**, see §4) and the paymaster/bundler
   integration.
5. **`services/contracts/src/`** — `SimpleAccount.sol`,
   `SimpleAccountFactory.sol`, the paymaster contract. **Known gap:**
   `SimpleAccount.sol`'s own nonce handling has not been reconciled against
   EntryPoint v0.7 semantics — treat this as an open item, not a hidden one.
6. **`services/backend/src/modules/auth/`** — WorkOS AuthKit integration
   (session cookie vs. bearer token), JWT issuance/verification, and whether
   the WorkOS↔local-user identity mapping (`workosUserId`) can be spoofed or
   confused across accounts.
7. **`services/backend/src/modules/social-recovery/`** — the M-of-N guardian
   model: whether recovery can be triggered without genuine guardian consent,
   and whether recovered access actually rotates custody correctly.
8. **`services/backend/src/common/middleware/rate-limit.middleware.ts`** — DoS
   and brute-force posture (Redis-backed, global across replicas, env-tunable
   limits).
9. Infra: `aws/cloudformation-*.yaml`, `k8s/*.yaml` — IAM least-privilege,
   network isolation (RDS/Redis in private subnets), Secrets Manager access
   scoping.

## 4. What we already know is incomplete — don't spend time rediscovering these

- **On-chain AA correctness is unverified.** We have a test
  (`test/integration/userop-hash.integration.test.ts`) that compares our
  `userOpHash` computation against the live EntryPoint's own `getUserOpHash`
  view function — it has not been run against a real RPC endpoint yet.
  `SimpleAccount.sol` needs a nonce-handling fix for EntryPoint v0.7 before an
  actual UserOp will validate.
- **No master-key rotation tooling** beyond the single-record primitive.
- **RDS point-in-time-restore and Multi-AZ failover** have not been exercised
  on real AWS infrastructure (a local Postgres backup/restore round-trip has).
- **Docker image and CI/CD have not been executed end-to-end** in a real
  environment yet.
- Full current status, with evidence for every claim: `PRODUCTION_STATUS.md`
  at the repo root.

## 5. Out of scope (for this engagement)

- Web (`apps/web`) and mobile (`apps/mobile`) clients — not hardened this pass,
  can be a separate follow-up engagement once the backend/contracts review is
  complete.
- DeFi swap/staking integrations (`services/backend/src/modules/defi`) — third
  party integrations (1inch, Lido), lower severity if compromised (no direct
  key exposure).

## 6. What we're asking for

- A manual code + architecture review against the priority list above.
- An explicit written opinion on whether the custody model (per-user derived
  keys, single master key in Secrets Manager, single decrypt path) is sound,
  and what would need to change if it isn't.
- A checklist of blocking vs. non-blocking findings, so we know what must be
  fixed before production traffic vs. what can follow.
- Estimated timeline and cost for: (a) a first-pass review of items 1–6 above,
  and (b) a follow-up review once the ERC-4337 on-chain gap is closed.

## 7. Repo access

Branch: `claude/privy-alternative-production-0qmmsn` (or `main` once merged).
Repository: `khayaai/open-privy`. Grant read access or provide a snapshot as
the firm's process requires.

---

*This brief is a starting point for scoping conversations, not a substitute
for the firm's own intake process. Fill in your preferred firms, budget, and
timeline before sending.*
