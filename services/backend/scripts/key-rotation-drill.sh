#!/usr/bin/env bash
#
# Master-key rotation drill: a full rehearsal of docs/DR_RUNBOOK.md Scenario D
# against a real Postgres and the real server, using the real rotation tool.
#
#   1. Wallets created under the OLD key (plus one legacy row with no key id).
#   2. Dry run: reports what it would do and writes NOTHING (DB checksum equal).
#   3. Servers switch to NEW (current) + OLD (previous): existing wallets still
#      sign, new wallets are written under NEW.
#   4. --apply while a server is running; every wallet verified before write.
#   5. Second --apply is a no-op (idempotent / resumable).
#   6. Restart with ONLY the NEW key: every EVM wallet decrypts and signs.
#   7. Negative control: the OLD key alone can no longer recover them.
#
# Runs in CI on every push (see .github/workflows/recovery-drill.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${DRILL_PORT:-4098}"
DB_NAME="${DRILL_DB_NAME:-openprivy_rotation_drill}"
DB_USER="${DRILL_DB_USER:-app}"
DB_PASSWORD="${DRILL_DB_PASSWORD:-dev}"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
JWT_SECRET="drill-test-secret-at-least-16-chars"
OLD_KEY="$(openssl rand -base64 32)"
NEW_KEY="$(openssl rand -base64 32)"
LOG_DIR="$(mktemp -d)"

log() { echo "[rotation-drill] $*"; }
fail() { echo "[rotation-drill] FAIL: $*"; exit 1; }

run_psql() {
  PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "${2:-postgres}" -tAc "$1" 2>/dev/null \
    || sudo -u postgres psql -d "${2:-postgres}" -tAc "$1" 2>/dev/null
}
db() { run_psql "$1" "$DB_NAME"; }
checksum() { db "SELECT md5(string_agg(id::text || coalesce(\"encryptedPrivateKey\",'') || coalesce(\"encryptionKeyId\",''), ',' ORDER BY id)) FROM wallets;"; }

export DATABASE_URL JWT_SECRET NODE_ENV=production DATABASE_SSL=false PORT
export SUPABASE_URL="https://example.supabase.co" SUPABASE_KEY="dummy"
export ETHEREUM_RPC_SEPOLIA="https://rpc.sepolia.org" ETHEREUM_RPC_POLYGON="https://polygon-rpc.com"
unset ENCRYPTION_MASTER_KEY_SECRET_ARN ENCRYPTION_MASTER_KEY_PREVIOUS || true

SERVER_PID=""
stop_server() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; fi
  for _ in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/health" 2>/dev/null)" = "000" ] && return 0
    sleep 0.5
  done
}
trap stop_server EXIT
wait_healthy() {
  for _ in $(seq 1 40); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/health" 2>/dev/null)" = "200" ] && return 0
    sleep 0.5
  done
  cat "$LOG_DIR/server.log"; return 1
}
# One wallet per chain per user is enforced, so each wallet gets its own user.
# Prints "<walletId> <address> <userId>".
create_wallet() {
  local uid token
  uid=$(node -e "console.log(require('crypto').randomUUID())")
  db "INSERT INTO users (id, email, \"emailVerified\", \"mfaEnabled\") VALUES ('${uid}','${uid}@drill.openprivy.io',true,false);" >/dev/null
  token=$(node -e "console.log(require('jsonwebtoken').sign({sub:process.argv[1],email:'drill@openprivy.io'},process.argv[2],{expiresIn:'30m'}))" "$uid" "$JWT_SECRET")
  curl -s -X POST "http://localhost:${PORT}/wallet/create" -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" -d "{\"chain\":\"$1\"}" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      if(!j.id){console.error(s);process.exit(1)}console.log(j.id+" "+j.address+" "+process.argv[1])})' "$uid"
}
verify_wallet() { # $1=walletId $2=address $3=userId; master keys from env
  DRILL_WALLET_ID="$1" DRILL_USER_ID="$3" DRILL_EXPECTED_ADDRESS="$2" \
    node dist/scripts/verify-custody-recovery.js >>"$LOG_DIR/verify.log" 2>&1
}

[ -f dist/scripts/rotate-master-key.js ] || fail "build first: npm run build"

# --- fresh database ------------------------------------------------------
log "fresh database ${DB_NAME}"
run_psql "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null
run_psql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" >/dev/null
ENCRYPTION_MASTER_KEY="$OLD_KEY" npm run migration:run >"$LOG_DIR/migrate.log" 2>&1 || { cat "$LOG_DIR/migrate.log"; fail "migrations"; }

# --- 1. wallets under the OLD key ----------------------------------------
log "1. creating wallets under the OLD key"
ENCRYPTION_MASTER_KEY="$OLD_KEY" node dist/main.js >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
wait_healthy || fail "server (old key) never became healthy"
EVM_WALLETS=()
for _ in 1 2 3; do EVM_WALLETS+=("$(create_wallet ethereum)"); done
EVM_WALLETS+=("$(create_wallet polygon)")
SOL_WALLET="$(create_wallet solana)"
stop_server
LEGACY_ID="${EVM_WALLETS[0]%% *}"
db "UPDATE wallets SET \"encryptionKeyId\" = NULL WHERE id = '${LEGACY_ID}';" >/dev/null
TOTAL=$(db "SELECT count(*) FROM wallets;")
log "   ${TOTAL} wallets (4 EVM, 1 Solana; ${LEGACY_ID} made legacy with no key id)"

# --- 2. dry run writes nothing --------------------------------------------
log "2. dry run (new key current, old key previous)"
BEFORE=$(checksum)
ENCRYPTION_MASTER_KEY="$NEW_KEY" ENCRYPTION_MASTER_KEY_PREVIOUS="$OLD_KEY" \
  node dist/scripts/rotate-master-key.js >"$LOG_DIR/dry.log" 2>&1 || { cat "$LOG_DIR/dry.log"; fail "dry run reported failures"; }
grep -q '"mode": "dry-run"' "$LOG_DIR/dry.log" || fail "dry run did not run in dry-run mode"
grep -q "\"rotated\": ${TOTAL}" "$LOG_DIR/dry.log" || { cat "$LOG_DIR/dry.log"; fail "dry run should plan ${TOTAL} rotations"; }
grep -q SAFE_TO_RETIRE "$LOG_DIR/dry.log" && fail "dry run must never declare it safe to retire keys"
[ "$(checksum)" = "$BEFORE" ] || fail "dry run modified the database"
log "   PASS: planned ${TOTAL} rotations, database byte-for-byte unchanged"

# --- 3. servers in rotation mode keep working ------------------------------
log "3. server on NEW+OLD: existing wallets sign, new wallets use NEW"
ENCRYPTION_MASTER_KEY="$NEW_KEY" ENCRYPTION_MASTER_KEY_PREVIOUS="$OLD_KEY" node dist/main.js >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
wait_healthy || fail "server (rotation config) never became healthy"
read -r W_ID W_ADDR W_USER <<<"${EVM_WALLETS[1]}"
ENCRYPTION_MASTER_KEY="$NEW_KEY" ENCRYPTION_MASTER_KEY_PREVIOUS="$OLD_KEY" verify_wallet "$W_ID" "$W_ADDR" "$W_USER" \
  || fail "old-key wallet could not sign during rotation"
MID_WALLET="$(create_wallet ethereum)"
EVM_WALLETS+=("$MID_WALLET")
TOTAL=$((TOTAL + 1))
NEW_KEY_ID=$(node -e "const c=require('crypto');console.log(c.createHash('sha256').update('openprivy-master-key-id:').update(Buffer.from(process.argv[1],'base64')).digest('hex').slice(0,16))" "$NEW_KEY")
[ "$(db "SELECT \"encryptionKeyId\" FROM wallets WHERE id='${MID_WALLET%% *}';")" = "$NEW_KEY_ID" ] \
  || fail "wallet created during rotation was not written under the new key"
log "   PASS: live signing unaffected; wallet created mid-rotation is on the new key"

# --- 4. apply, with the server still running --------------------------------
log "4. --apply while the server is live"
ENCRYPTION_MASTER_KEY="$NEW_KEY" ENCRYPTION_MASTER_KEY_PREVIOUS="$OLD_KEY" \
  node dist/scripts/rotate-master-key.js --apply >"$LOG_DIR/apply.log" 2>&1 || { cat "$LOG_DIR/apply.log"; fail "apply reported failures"; }
grep -q SAFE_TO_RETIRE_PREVIOUS_KEYS "$LOG_DIR/apply.log" || { cat "$LOG_DIR/apply.log"; fail "apply did not finish cleanly"; }
[ "$(db "SELECT count(*) FROM wallets WHERE \"encryptionKeyId\" IS DISTINCT FROM '${NEW_KEY_ID}';")" = "0" ] \
  || fail "some wallets are still not on the new key"
log "   PASS: $(grep -o '"rotated": [0-9]*' "$LOG_DIR/apply.log") (mid-rotation wallet was already current); all ${TOTAL} on the new key"
stop_server

# --- 5. idempotent ----------------------------------------------------------
log "5. second --apply is a no-op"
AFTER=$(checksum)
ENCRYPTION_MASTER_KEY="$NEW_KEY" ENCRYPTION_MASTER_KEY_PREVIOUS="$OLD_KEY" \
  node dist/scripts/rotate-master-key.js --apply >"$LOG_DIR/apply2.log" 2>&1 || fail "second apply failed"
grep -q '"scanned": 0' "$LOG_DIR/apply2.log" || { cat "$LOG_DIR/apply2.log"; fail "second apply was not a no-op"; }
[ "$(checksum)" = "$AFTER" ] || fail "second apply changed data"
log "   PASS: nothing left to do, data unchanged"

# --- 6. old key retired ---------------------------------------------------
log "6. old key retired: every EVM wallet must sign with the NEW key alone"
for entry in "${EVM_WALLETS[@]}"; do
  read -r W_ID W_ADDR W_USER <<<"$entry"
  ENCRYPTION_MASTER_KEY="$NEW_KEY" verify_wallet "$W_ID" "$W_ADDR" "$W_USER" || { cat "$LOG_DIR/verify.log"; fail "wallet ${W_ID} lost after retiring the old key"; }
done
log "   PASS: ${#EVM_WALLETS[@]} EVM wallets recovered and signed (Solana key verified against its address during rotation)"

# --- 7. negative control ---------------------------------------------------
log "7. negative control: the OLD key alone must now fail"
read -r W_ID W_ADDR W_USER <<<"${EVM_WALLETS[2]}"
if ENCRYPTION_MASTER_KEY="$OLD_KEY" verify_wallet "$W_ID" "$W_ADDR" "$W_USER"; then
  fail "old key still decrypts rotated data; the rotation did not happen"
fi
log "   PASS: old key can no longer decrypt"

# --- 8. a row that fails verification is refused, untouched, and blocks retirement
log "8. poisoned row: key that does not match its address must be refused"
read -r W_ID W_ADDR W_USER <<<"${EVM_WALLETS[3]}"
BAD_ADDR=$(node -e "console.log(require('ethers').Wallet.createRandom().address)")
BAD_ID=$(db "INSERT INTO wallets (\"userId\", address, chain, \"encryptedPrivateKey\", \"encryptionKeyId\", \"signingMode\")
  SELECT \"userId\", '${BAD_ADDR}', 'ethereum', \"encryptedPrivateKey\", NULL, 'software' FROM wallets WHERE id='${W_ID}' RETURNING id;" | head -1)
BAD_BEFORE=$(db "SELECT md5(\"encryptedPrivateKey\" || coalesce(\"encryptionKeyId\",'')) FROM wallets WHERE id='${BAD_ID}';")
set +e
ENCRYPTION_MASTER_KEY="$NEW_KEY" node dist/scripts/rotate-master-key.js --apply >"$LOG_DIR/poison.log" 2>&1
CODE=$?
set -e
[ "$CODE" = "1" ] || { cat "$LOG_DIR/poison.log"; fail "tool should exit 1 on an unverifiable row (got $CODE)"; }
grep -q "${BAD_ID}" "$LOG_DIR/poison.log" && grep -q "does not derive the wallet address" "$LOG_DIR/poison.log" \
  || { cat "$LOG_DIR/poison.log"; fail "poisoned row not reported with the right reason"; }
grep -q SAFE_TO_RETIRE "$LOG_DIR/poison.log" && fail "must not declare safe to retire with a failed row"
[ "$(db "SELECT md5(\"encryptedPrivateKey\" || coalesce(\"encryptionKeyId\",'')) FROM wallets WHERE id='${BAD_ID}';")" = "$BAD_BEFORE" ] \
  || fail "poisoned row was modified"
log "   PASS: refused with exit 1, row untouched, retirement blocked"

log "ROTATION_DRILL_OK"
