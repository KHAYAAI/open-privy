# OpenPrivy — Disaster Recovery Runbook

Scope: the stateful tier (PostgreSQL, Redis) and the encryption master key. The
backend itself is stateless — pods are recreated from the ECR image, so recovery
there is just a redeploy.

## Targets

| | Target | Basis |
|---|---|---|
| **RPO** (data loss) | ≤ 5 min | RDS Multi-AZ sync replica + automated backups |
| **RTO** (time to restore) | ≤ 60 min | snapshot restore + redeploy |

Redis is a cache (rate-limit counters, sessions). Losing it is non-fatal: limits
reset and users re-authenticate. Do not treat Redis as a system of record.

## The one thing that makes backups useless if lost

Wallet private keys are stored **encrypted with per-user keys derived from the
Secrets Manager master key**. A database restore only yields usable wallets if
the **same master key** is still in Secrets Manager. Therefore:

- The master-key secret has its own protection: **never delete it**, enable
  Secrets Manager **rotation with re-encryption** (not blind rotation), and
  replicate it to a second region.
- A DB restore + a rotated-away master key = permanently undecryptable wallets.
  Test decrypt after every restore drill.

## Scenario A — RDS instance failure (most common)

Multi-AZ fails over automatically (~1–2 min). Action: confirm the new writer,
confirm the app reconnected (`/health` 200, error rate normal). No data loss.

## Scenario B — data corruption / bad migration / accidental delete

1. Identify a good point in time (before the event).
2. **RDS point-in-time restore** to a *new* instance (console/CLI). Do not
   overwrite the live instance.
3. Repoint `DATABASE_URL` (Secrets Manager / k8s Secret) at the restored writer.
4. `kubectl rollout restart deployment/backend -n openprivy`.
5. Verify: row counts, and **decrypt one wallet** to confirm the master key still
   matches.

## Scenario C — full region / logical restore from dump

Uses the portable logical backup (`scripts/db-backup.sh` → S3, SSE-AES256):

```bash
TARGET_URL=postgres://…/openprivy_restore DUMP=openprivy-<ts>.dump \
  scripts/db-restore.sh
```

The restore script prints core-table row counts. Then repoint + redeploy as above.

**This round-trip is tested**: `db-backup.sh` (pg_dump custom format) →
`db-restore.sh` (pg_restore --clean into a fresh DB) was verified to reproduce
identical row counts, with `encryptedPrivateKey` values intact.

## Scenario D — master-key rotation (scheduled, or suspected compromise)

Rotation runs **without downtime**. Servers accept a *current* key (encrypts
everything new) plus *previous* keys (decrypt only), and the batch tool
re-encrypts every software wallet under the current key, proving each one
still derives its own address before writing it. Rehearsed end to end on every
push by `npm run drill:rotation` (`scripts/key-rotation-drill.sh`).

1. **Generate the new key** (never reuse, never derive from the old one):
   `openssl rand -base64 32`.
2. **Put both keys in the secret** as a new version of the master-key secret:
   ```json
   { "ENCRYPTION_MASTER_KEY": "<NEW>", "ENCRYPTION_MASTER_KEY_PREVIOUS": ["<OLD>"] }
   ```
   Keep a copy of the old key somewhere safe until step 6 is done.
3. **Roll the servers** (`kubectl rollout restart deployment/backend -n openprivy`).
   Logs show `Encryption master key loaded (id <new-id>, 1 previous key(s) ...)`.
   Existing wallets keep working; new wallets are written under the new key.
4. **Dry run** (writes nothing), as a one-off Job/pod with the backend image
   and the same config: `node dist/scripts/rotate-master-key.js`.
   Check `"failed": []` and that `"rotated"` matches the number of software wallets.
5. **Apply**: `node dist/scripts/rotate-master-key.js --apply`. Safe to run
   while serving traffic and safe to re-run (it resumes; finished rows are
   skipped). Exit code 1 means some wallets were refused; nothing was written
   for them. Investigate each id in the report before going further.
6. **Retire the old key** only after an apply run prints
   `SAFE_TO_RETIRE_PREVIOUS_KEYS`: remove `ENCRYPTION_MASTER_KEY_PREVIOUS` from
   the secret, roll the servers, and decrypt-test one wallet.
7. **Suspected compromise**: also rotate `JWT_SECRET` (invalidates sessions),
   and treat the old key as burned: funds in wallets whose keys may have been
   decrypted by an attacker must be moved to new wallets, which rotation alone
   does not do.

Never delete or overwrite the master-key secret without step 6. Rows still
under a retired key are permanently undecryptable.

## Scenario E — HSM-signed wallets (opt-in `signingMode: "hsm"`)

**This scenario is NOT covered by any of the above.** An HSM wallet has no
`encryptedPrivateKey` at all — its key exists only inside the PKCS#11 token
(CloudHSM/Luna/YubiHSM), referenced by `hsmKeyLabel`. Restoring the Postgres
database restores the *reference* to that key, not the key itself.

- If the **database** is lost and restored from backup: HSM wallets recover
  fully, same as software wallets — `hsmKeyLabel` is just a row.
- If the **HSM/token itself** is lost (not the database): HSM wallets are
  **permanently unrecoverable** unless the HSM vendor's own backup/cloning
  mechanism was used (e.g., CloudHSM cluster replication, Luna backup HSMs).
  This is a vendor-specific procedure outside this repo's scope — confirm it
  exists and is tested *before* creating any HSM-mode wallet holding real value.
- The master-key-rotation concern in Scenario D does not apply to HSM wallets
  at all — there is no software master key protecting them. This is a genuine
  advantage of the HSM path, not just a different failure mode.

## Quarterly DR drill checklist

- [ ] PITR restore to a scratch instance completes within RTO.
- [ ] Logical `db-restore.sh` reproduces row counts.
- [ ] **Decrypt a wallet from the restored DB** using the live master key.
- [ ] Backend reconnects and serves `/health` 200 against the restored DB.
- [ ] Redis loss tolerated (limits reset, logins recover).
- [ ] If any HSM-mode wallets exist: confirm the HSM vendor's own
      backup/replication is configured and tested — Postgres backups alone
      do not protect them.
- [ ] Findings logged; runbook updated.
