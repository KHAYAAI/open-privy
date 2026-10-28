#!/usr/bin/env bash
#
# Authorization drill: real server, real Postgres, real HTTP. Two users, A and
# B. Every check is "B must not be able to touch A's data", plus the CSRF rule
# for the browser cookie session. Each FAIL here was a real bug before.
#
# Runs in CI on every push (see .github/workflows/recovery-drill.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${DRILL_PORT:-4096}"
DB_NAME="${DRILL_DB_NAME:-openprivy_authz_drill}"
DB_USER="${DRILL_DB_USER:-app}"
DB_PASSWORD="${DRILL_DB_PASSWORD:-dev}"
JWT_SECRET="authz-drill-secret-at-least-16-chars"
LOG_DIR="$(mktemp -d)"
BASE="http://localhost:${PORT}"
PASSES=0

log() { echo "[authz-drill] $*"; }
fail() { echo "[authz-drill] FAIL: $*"; exit 1; }
pass() { PASSES=$((PASSES + 1)); log "PASS: $*"; }
run_psql() {
  PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "${2:-postgres}" -tAc "$1" 2>/dev/null \
    || sudo -u postgres psql -d "${2:-postgres}" -tAc "$1" 2>/dev/null
}
db() { run_psql "$1" "$DB_NAME"; }
# status <method> <path> <token|-> [json] [extra curl args...]
status() {
  local method=$1 path=$2 token=$3 body=${4:-}; shift 4 || shift $#
  local args=(-s -o "$LOG_DIR/body" -w '%{http_code}' -X "$method" "$BASE$path")
  [ "$token" != "-" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$@"
}
body() { cat "$LOG_DIR/body"; }
new_user() {
  local uid; uid=$(node -e "console.log(require('crypto').randomUUID())")
  db "INSERT INTO users (id, email, \"emailVerified\", \"mfaEnabled\") VALUES ('$uid','$uid@authz.openprivy.io',true,false);" >/dev/null
  node -e "console.log(require('jsonwebtoken').sign({sub:process.argv[1],email:'x@authz.openprivy.io'},process.argv[2],{expiresIn:'15m'}))" "$uid" "$JWT_SECRET"
}

run_psql "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null
run_psql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" >/dev/null
export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
export JWT_SECRET NODE_ENV=production DATABASE_SSL=false PORT ENCRYPTION_MASTER_KEY="$(openssl rand -base64 32)"
export SUPABASE_URL="https://example.supabase.co" SUPABASE_KEY="dummy"
export ETHEREUM_RPC_SEPOLIA="https://rpc.sepolia.org" ETHEREUM_RPC_POLYGON="https://polygon-rpc.com"
export CORS_ORIGINS="http://localhost:3000"
npm run migration:run >"$LOG_DIR/migrate.log" 2>&1 || { cat "$LOG_DIR/migrate.log"; fail "migrations"; }

SERVER_PID=""
start_server() { # $1 = ENABLE_SOCIAL_RECOVERY value
  ENABLE_SOCIAL_RECOVERY="$1" node dist/main.js >"$LOG_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health" 2>/dev/null)" = "200" ] && return 0
    sleep 0.5
  done
  cat "$LOG_DIR/server.log"; fail "server never became healthy"
}
stop_server() { [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }; }
trap stop_server EXIT

A=$(new_user); B=$(new_user)

# --- social recovery is off by default -------------------------------------
start_server false
[ "$(status GET /recovery/contacts "$A")" = "404" ] || fail "social recovery routes should be hidden (404) when disabled"
pass "social recovery is off unless ENABLE_SOCIAL_RECOVERY=true"
stop_server

start_server true

# --- wallets ---------------------------------------------------------------
[ "$(status POST /wallet/create "$A" '{"chain":"ethereum"}')" = "201" ] || { body; fail "A could not create a wallet"; }
WALLET_A=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).id)" "$LOG_DIR/body")

[ "$(status GET "/wallet/${WALLET_A}/balance" "$B")" = "403" ] || { body; fail "B read A's wallet balance"; }
pass "B cannot read A's wallet balance (403)"

[ "$(status POST "/wallet/${WALLET_A}/recovery-email" "$B" '{"recoveryEmail":"attacker@evil.example"}')" = "403" ] \
  || { body; fail "B changed A's wallet recovery email"; }
[ "$(db "SELECT coalesce(\"recoveryEmail\",'') FROM wallets WHERE id='${WALLET_A}';")" = "" ] || fail "A's recovery email was modified"
pass "B cannot set A's wallet recovery email (403, row unchanged)"

[ "$(status POST "/wallet/${WALLET_A}/recovery-email" "$A" '{"recoveryEmail":"not-an-email"}')" = "400" ] \
  || { body; fail "invalid recovery email accepted"; }
pass "recovery email is validated (400)"

[ "$(status POST /transactions/send "$B" "{\"walletId\":\"${WALLET_A}\",\"to\":\"0x000000000000000000000000000000000000dEaD\",\"amount\":\"0.01\"}")" != "201" ] \
  || fail "B sent funds from A's wallet"
grep -qi "does not belong" "$LOG_DIR/body" || { body; fail "send from A's wallet by B was not refused for ownership"; }
pass "B cannot send from A's wallet"

# --- social recovery (enabled) ---------------------------------------------
[ "$(status POST /recovery/contacts "$A" '{"contactName":"A Guardian","contactEmail":"guardian@example.com"}')" = "201" ] \
  || { body; fail "A could not add a recovery contact"; }
grep -q verificationToken "$LOG_DIR/body" && fail "add-contact response leaks the verification token to the account owner"
CONTACT_A=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).contact.id)" "$LOG_DIR/body")
pass "add-contact response does not include the verification token"

status GET /recovery/contacts "$B" >/dev/null
grep -q "$CONTACT_A" "$LOG_DIR/body" && fail "B can list A's recovery contacts"
[ "$(body)" = "[]" ] || { body; fail "B should see an empty contact list"; }
pass "B cannot list A's recovery contacts"

status GET /recovery/contacts "$A" >/dev/null
grep -q "$CONTACT_A" "$LOG_DIR/body" || { body; fail "A cannot see own contact"; }
grep -q verificationToken "$LOG_DIR/body" && fail "contact list leaks verification tokens"
pass "A sees own contacts, without tokens"

status DELETE "/recovery/contacts/${CONTACT_A}" "$B" >/dev/null
[ "$(db "SELECT count(*) FROM recovery_contacts WHERE id='${CONTACT_A}';")" = "1" ] || fail "B deleted A's recovery contact"
pass "B cannot delete A's recovery contact"

# --- CSRF on the cookie session ----------------------------------------------
[ "$(status POST /auth/logout - '' -H "Cookie: op_session=${A}")" = "403" ] || { body; fail "cookie POST without X-CSRF-Token was accepted"; }
pass "cookie-authenticated POST without X-CSRF-Token is rejected (403)"
[ "$(status POST /auth/logout - '' -H "Cookie: op_session=${A}" -H 'X-CSRF-Token: 1')" = "201" ] || { body; fail "cookie POST with header rejected"; }
pass "cookie-authenticated POST with X-CSRF-Token is accepted"
[ "$(status GET /auth/me - '' -H "Cookie: op_session=${A}")" = "200" ] || { body; fail "cookie GET rejected"; }
pass "cookie-authenticated GET works without the header"

log "AUTHZ_DRILL_OK (${PASSES} checks)"
