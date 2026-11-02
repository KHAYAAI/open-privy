#!/usr/bin/env bash
#
# Social recovery drill: real server, real Postgres, real HTTP, emails captured
# in a test outbox (the only place one-time links exist, as in production).
#
#   1. Owner adds 3 guardians; no token ever appears in an API response.
#   2. Guardians confirm through their own links (2 of 3 threshold).
#   3. A new account requests recovery; guardians and the owner are emailed.
#   4. Replayed approval links are refused; 2 approvals start the time lock.
#   5. After the lock the wallet moves: it signs from the new account with its
#      original address, the old account's session is dead, and the old
#      account can no longer decrypt it.
#   6. Negative runs: the owner cancels during the lock (nothing moves); a
#      guardian declines (request ends, 24h cooldown, no new emails); unknown
#      accounts get the same response as real ones.
#
# Runs in CI on every push (see .github/workflows/recovery-drill.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${DRILL_PORT:-4094}"
DB_NAME="${DRILL_DB_NAME:-openprivy_social_drill}"
DB_USER="${DRILL_DB_USER:-app}"
DB_PASSWORD="${DRILL_DB_PASSWORD:-dev}"
JWT_SECRET="social-drill-secret-at-least-16-chars"
LOG_DIR="$(mktemp -d)"
OUTBOX="$LOG_DIR/outbox.jsonl"
BASE="http://localhost:${PORT}"
PASSES=0

log() { echo "[social-drill] $*"; }
fail() { echo "[social-drill] FAIL: $*"; exit 1; }
pass() { PASSES=$((PASSES + 1)); log "PASS: $*"; }
run_psql() {
  PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "${2:-postgres}" -tAc "$1" 2>/dev/null \
    || sudo -u postgres psql -d "${2:-postgres}" -tAc "$1" 2>/dev/null
}
db() { run_psql "$1" "$DB_NAME"; }
# req <method> <path> <token|-> [json]  -> sets CODE, body in $LOG_DIR/body
req() {
  local args=(-s -o "$LOG_DIR/body" -w '%{http_code}' -X "$1" "$BASE$2" -H 'Content-Type: application/json')
  [ "$3" != "-" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && args+=(-d "$4")
  CODE=$(curl "${args[@]}")
}
body() { cat "$LOG_DIR/body"; }
json() { node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1]));console.log(eval('j'+process.argv[2]))" "$LOG_DIR/body" "$1"; }
new_user() { # $1 email -> prints "<uuid> <jwt>"
  local uid; uid=$(node -e "console.log(require('crypto').randomUUID())")
  db "INSERT INTO users (id, email, \"emailVerified\", \"mfaEnabled\") VALUES ('$uid','$1',true,false);" >/dev/null
  echo "$uid $(node -e "console.log(require('jsonwebtoken').sign({sub:process.argv[1],email:process.argv[2]},process.argv[3],{expiresIn:'30m'}))" "$uid" "$1" "$JWT_SECRET")"
}
# Latest one-time token emailed to <address> whose link path contains <path>.
token_for() {
  node -e "
    const lines=require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse);
    const m=lines.filter(x=>x.to===process.argv[2]).map(x=>x.text.match(new RegExp(process.argv[3]+'\\\\?token=([A-Za-z0-9_-]{43})'))).filter(Boolean);
    if(!m.length){process.exit(1)} console.log(m[m.length-1][1]);" "$OUTBOX" "$1" "$2"
}
outbox_count() { [ -f "$OUTBOX" ] && wc -l < "$OUTBOX" | tr -d ' ' || echo 0; }

run_psql "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null
run_psql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" >/dev/null
export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
export JWT_SECRET DATABASE_SSL=false PORT ENCRYPTION_MASTER_KEY="$(openssl rand -base64 32)"
export SUPABASE_URL="https://example.supabase.co" SUPABASE_KEY="dummy"
export ETHEREUM_RPC_SEPOLIA="https://rpc.sepolia.org" ETHEREUM_RPC_POLYGON="https://polygon-rpc.com"
export CORS_ORIGINS="http://localhost:3000"
npm run migration:run >"$LOG_DIR/migrate.log" 2>&1 || { cat "$LOG_DIR/migrate.log"; fail "migrations"; }

# NODE_ENV=test: the email outbox refuses production. 3-second time lock for the drill.
NODE_ENV=test ENABLE_SOCIAL_RECOVERY=true NOTIFIER_PROVIDER=outbox NOTIFIER_OUTBOX_FILE="$OUTBOX" \
  RECOVERY_TIME_LOCK_HOURS=0.000834 RECOVERY_SWEEP_INTERVAL_MS=500 \
  node dist/main.js >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")" = "200" ] && break; sleep 0.5; done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")" = "200" ] || { cat "$LOG_DIR/server.log"; fail "server never became healthy"; }

# ------------------------------------------------------------- happy path
read -r OWNER OWNER_JWT <<<"$(new_user owner@drill.example)"
read -r NEWACC NEW_JWT <<<"$(new_user owner-new@drill.example)"
req POST /wallet/create "$OWNER_JWT" '{"chain":"ethereum"}'
[ "$CODE" = "201" ] || { body; fail "owner wallet"; }
WALLET=$(json .id); ADDRESS=$(json .address)
log "owner wallet $WALLET ($ADDRESS)"

for g in alice bob carol; do
  req POST /recovery/guardians "$OWNER_JWT" "{\"name\":\"$g\",\"email\":\"$g@guardian.example\"}"
  [ "$CODE" = "201" ] || { body; fail "add guardian $g"; }
  grep -qi token "$LOG_DIR/body" && fail "add-guardian response contains a token"
done
req GET /recovery/guardians "$OWNER_JWT"
grep -qi token "$LOG_DIR/body" && fail "guardian list contains a token"
[ "$(json .recoveryReady)" = "false" ] || fail "recovery should not be ready before guardians confirm"
pass "3 guardians invited; no token in any API response; not ready until they confirm"

req POST /recovery/guardians "$OWNER_JWT" '{"name":"me","email":"owner@drill.example"}'
[ "$CODE" = "400" ] || fail "owner could add themselves as a guardian"
pass "owner cannot be their own guardian"

for g in alice bob carol; do
  T=$(token_for "$g@guardian.example" /recovery/guardian) || fail "no invite email for $g"
  req POST /recovery/guardian-invites/lookup - "{\"token\":\"$T\"}"
  [ "$CODE" = "200" ] && [ "$(json .ownerEmail)" = "owner@drill.example" ] || { body; fail "invite lookup"; }
  req POST /recovery/guardian-invites/confirm - "{\"token\":\"$T\"}"
  [ "$CODE" = "200" ] || { body; fail "confirm $g"; }
done
req POST /recovery/guardian-invites/confirm - "{\"token\":\"$T\"}"
[ "$CODE" = "404" ] || fail "invite link worked twice"
req GET /recovery/guardians "$OWNER_JWT"
[ "$(json .recoveryReady)" = "true" ] && [ "$(json .threshold)" = "2" ] || { body; fail "not ready after confirmations"; }
pass "guardians confirm through their own links (single use); threshold 2 of 3"

BEFORE=$(outbox_count)
req POST /recovery/requests "$NEW_JWT" '{"oldAccountEmail":"nobody@drill.example"}'
GENERIC=$(json .message)
[ "$CODE" = "202" ] && [ "$(outbox_count)" = "$BEFORE" ] || fail "unknown account was not handled silently"
req POST /recovery/requests "$NEW_JWT" '{"oldAccountEmail":"Owner@Drill.example"}'
[ "$CODE" = "202" ] && [ "$(json .message)" = "$GENERIC" ] || { body; fail "real request response differs from unknown-account response"; }
[ "$(outbox_count)" = "$((BEFORE + 4))" ] || fail "expected 3 guardian emails + 1 owner warning"
token_for owner@drill.example /recovery/cancel >/dev/null || fail "owner was not warned"
pass "request answers identically for unknown and real accounts; 3 guardians asked, owner warned"

A1=$(token_for alice@guardian.example /recovery/approve); A2=$(token_for bob@guardian.example /recovery/approve)
req POST /recovery/approvals/lookup - "{\"token\":\"$A1\"}"
[ "$(json .requestedBy)" = "owner-new@drill.example" ] || { body; fail "approval page details"; }
req POST /recovery/approvals/decide - "{\"token\":\"$A1\",\"decision\":\"approve\"}"
[ "$(json .status)" = "awaiting_approvals" ] || { body; fail "first approval"; }
req POST /recovery/approvals/decide - "{\"token\":\"$A1\",\"decision\":\"approve\"}"
[ "$CODE" = "404" ] || fail "approval link worked twice"
req POST /recovery/approvals/decide - "{\"token\":\"$A2\",\"decision\":\"approve\"}"
[ "$(json .status)" = "time_locked" ] || { body; fail "threshold did not start the time lock"; }
pass "replayed approval refused; 2 approvals start the time lock"

req GET /auth/me "$OWNER_JWT"
[ "$CODE" = "200" ] || fail "owner session should work during the time lock"
for _ in $(seq 1 20); do
  req GET /recovery/requests/current "$NEW_JWT"
  [ "$(json .status)" = "completed" ] && break; sleep 0.5
done
[ "$(json .status)" = "completed" ] || { body; tail -20 "$LOG_DIR/server.log"; fail "recovery did not complete after the time lock"; }
pass "recovery completes after the time lock"

[ "$(db "SELECT \"userId\" FROM wallets WHERE id='$WALLET';")" = "$NEWACC" ] || fail "wallet not moved"
req GET /wallet/get "$NEW_JWT"
[ "$(json .address)" = "$ADDRESS" ] || { body; fail "new account does not see the original address"; }
DRILL_WALLET_ID="$WALLET" DRILL_USER_ID="$NEWACC" DRILL_EXPECTED_ADDRESS="$ADDRESS" NODE_ENV=test \
  node dist/scripts/verify-custody-recovery.js >"$LOG_DIR/verify.log" 2>&1 || { cat "$LOG_DIR/verify.log"; fail "new account cannot sign"; }
pass "new account owns the wallet, same address, and signs with it"

req GET /auth/me "$OWNER_JWT"
[ "$CODE" = "401" ] || fail "old account session still works after recovery"
[ -n "$(db "SELECT \"lockedAt\" FROM users WHERE id='$OWNER';")" ] || fail "old account not locked"
db "UPDATE wallets SET \"userId\"='$OWNER' WHERE id='$WALLET';" >/dev/null
if DRILL_WALLET_ID="$WALLET" DRILL_USER_ID="$OWNER" DRILL_EXPECTED_ADDRESS="$ADDRESS" NODE_ENV=test \
   node dist/scripts/verify-custody-recovery.js >>"$LOG_DIR/verify.log" 2>&1; then
  fail "old account's key derivation still decrypts the moved wallet"
fi
db "UPDATE wallets SET \"userId\"='$NEWACC' WHERE id='$WALLET';" >/dev/null
pass "old account locked, its session rejected, and its key no longer decrypts the wallet"

# ------------------------------------------------------------- negative: owner cancels
setup_owner() { # $1 prefix -> sets O_ID O_JWT O_WALLET R_ID R_JWT, guardians confirmed
  read -r O_ID O_JWT <<<"$(new_user "$1@drill.example")"
  read -r R_ID R_JWT <<<"$(new_user "$1-claim@drill.example")"
  req POST /wallet/create "$O_JWT" '{"chain":"ethereum"}'; O_WALLET=$(json .id)
  for g in g1 g2 g3; do
    req POST /recovery/guardians "$O_JWT" "{\"name\":\"$g\",\"email\":\"$1-$g@guardian.example\"}"
    req POST /recovery/guardian-invites/confirm - "{\"token\":\"$(token_for "$1-$g@guardian.example" /recovery/guardian)\"}"
  done
  req POST /recovery/requests "$R_JWT" "{\"oldAccountEmail\":\"$1@drill.example\"}"
}

setup_owner cancel
for g in g1 g2; do req POST /recovery/approvals/decide - "{\"token\":\"$(token_for "cancel-$g@guardian.example" /recovery/approve)\",\"decision\":\"approve\"}"; done
[ "$(json .status)" = "time_locked" ] || { body; fail "cancel scenario did not reach the time lock"; }
req POST /recovery/requests/cancel - "{\"token\":\"$(token_for cancel@drill.example /recovery/cancel)\"}"
[ "$CODE" = "200" ] || { body; fail "owner cancel link"; }
sleep 4
req GET /recovery/requests/current "$R_JWT"
[ "$(json .status)" = "cancelled" ] || { body; fail "request not cancelled"; }
[ "$(db "SELECT \"userId\" FROM wallets WHERE id='$O_WALLET';")" = "$O_ID" ] || fail "wallet moved despite cancellation"
req GET /auth/me "$O_JWT"; [ "$CODE" = "200" ] || fail "owner locked out after cancelling"
pass "owner cancels during the time lock: nothing moves, owner keeps access"

# ------------------------------------------------------------- negative: guardian declines + cooldown
setup_owner decline
req POST /recovery/approvals/decide - "{\"token\":\"$(token_for "decline-g1@guardian.example" /recovery/approve)\",\"decision\":\"approve\"}"
req POST /recovery/approvals/decide - "{\"token\":\"$(token_for "decline-g2@guardian.example" /recovery/approve)\",\"decision\":\"decline\"}"
[ "$(json .status)" = "declined" ] || { body; fail "decline did not end the request"; }
req POST /recovery/approvals/decide - "{\"token\":\"$(token_for "decline-g3@guardian.example" /recovery/approve)\",\"decision\":\"approve\"}"
[ "$CODE" = "404" ] || fail "approval accepted on a declined request"
read -r _R2 R2_JWT <<<"$(new_user decline-claim2@drill.example)"
BEFORE=$(outbox_count)
req POST /recovery/requests "$R2_JWT" '{"oldAccountEmail":"decline@drill.example"}'
[ "$CODE" = "202" ] && [ "$(outbox_count)" = "$BEFORE" ] || fail "new request during the 24h cooldown was not silently blocked"
[ "$(db "SELECT \"userId\" FROM wallets WHERE id='$O_WALLET';")" = "$O_ID" ] || fail "wallet moved after a decline"
pass "one decline ends the request; later approvals refused; 24h cooldown blocks a new attempt silently"

log "SOCIAL_RECOVERY_DRILL_OK (${PASSES} checks)"
