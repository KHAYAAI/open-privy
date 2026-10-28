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

Master-key rotation is zero-downtime: servers decrypt with the current key or
any configured previous key (AES-GCM authentication makes a wrong key fail
deterministically) and encrypt only with the current key. The batch tool
(`src/scripts/rotate-master-key.ts`, core in `src/common/encryption/key-rotation.ts`)
re-encrypts each wallet only after proving its key derives its stored address,
writes with an optimistic-concurrency check, and is rehearsed in CI
(`scripts/key-rotation-drill.sh`). Please review the retire-the-old-key
decision logic in particular.

**An alternative, opt-in path exists per wallet**: `signingMode: "hsm"`
generates the key non-extractable directly on a PKCS#11 token (CloudHSM/
Luna/YubiHSM in production; verified here against SoftHSM2) instead of
encrypting it in the database — see
`services/backend/src/common/signing/hsm-signing-key.ts`. The master-key
compromise/rotation concern above does not apply to these wallets at all, at
the cost of needing the HSM vendor's own backup/replication story for DR
(not yet tested against physical hardware — see §4 below).

## 3. Priority order for review

1. **`services/backend/src/common/encryption/encryption.service.ts`** and
   **`master-key.loader.ts`** — the encryption primitive and master-key
   resolution (env var locally, Secrets Manager in production).
2. **`services/backend/src/modules/wallet/wallet.service.ts`** — the only
   decrypt path; ownership checks; whether any other path could be induced to
   leak key material (error messages, logs, serialization). Also covers the
   HSM branch (`createHsmWallet`/`getEvmSigner`'s HSM case) — same ownership
   checks apply, but there is no plaintext to leak in the first place.
2b. **`services/backend/src/common/signing/hsm-signing-key.ts`** and
   **`pkcs11.service.ts`** — the PKCS#11-backed signer: low-S normalization,
   recovery-id (v) resolution by trial recovery against the token's own
   public key, and whether the session/login handling could leak the PIN or
   leave a session open to reuse across tenants.
3. **`services/backend/src/modules/transactions/transaction.service.ts`** —
   the custodial send path: decrypt → sign → broadcast, and whether an
   authenticated user could ever trigger a signature over a wallet they don't
   own.
4. **`services/backend/src/modules/account-abstraction/`**: ERC-4337 UserOp
   construction, sponsorship ordering (paymaster data is attached before the
   owner signs), sanctions screening of decoded destinations including ERC-20
   recipients, and the v0.7 bundler RPC format. Proven against the real
   EntryPoint v0.7 on a local chain; not yet against a public bundler.
5. **`services/contracts/src/`**: `SimpleAccount.sol`, `SimpleAccountFactory.sol`,
   `OpenPrivyPaymaster.sol`, built on `@account-abstraction/contracts` 0.7.0
   (UUPS-upgradeable account, EntryPoint-managed nonces, verifying paymaster
   with an allow-list). Upgrade authorization and the paymaster's signed-hash
   coverage deserve a close look.
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

- **Gasless transactions are proven on a local chain only.** The real
  EntryPoint v0.7 executes ops built and signed by the backend
  (`services/contracts/scripts/aa-e2e.sh`), but no op has gone through a
  public bundler (Pimlico) on Sepolia yet.
- **Master-key rotation has not been run against a real Secrets Manager
  secret**, only rehearsed with env-var keys against real Postgres.
- **RDS point-in-time-restore and Multi-AZ failover** have not been exercised
  on real AWS infrastructure (a local Postgres backup/restore round-trip has).
- **Docker image and CI/CD have not been executed end-to-end** in a real
  environment yet.
- **HSM signing has only been exercised against SoftHSM2** (a software
  PKCS#11 implementation), not physical HSM hardware. The signing math
  (low-S normalization, recovery-id resolution) is hardware-agnostic PKCS#11
  behavior, but hasn't been confirmed against a specific vendor's quirks
  (CloudHSM/Luna/YubiHSM).
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
