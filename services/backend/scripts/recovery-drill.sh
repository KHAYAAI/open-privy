#!/usr/bin/env bash
#
# Recovery drill: proves that custody survives a hard process kill and
# restart with keys pulled fresh from their source (Secrets Manager in
# production; an env var here) — not from anything cached in memory.
#
# Modeled on the "kill it, restore it, prove it still signs correctly"
# pattern: create a wallet against a live server, SIGKILL the process,
# start a brand-new process pointed at the same database and the same
# master key, and prove — using the real production code path, not a
# reimplementation — that it can still decrypt and sign for that wallet.
# Then proves the negative: a restart with the WRONG master key must fail,
# so this drill isn't vacuously true.
#
# Runs in CI on every push (see .github/workflows/recovery-drill.yml).
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${DRILL_PORT:-4099}"
DB_NAME="${DRILL_DB_NAME:-openprivy_drill}"
DB_USER="${DRILL_DB_USER:-app}"
DB_PASSWORD="${DRILL_DB_PASSWORD:-dev}"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
JWT_SECRET="drill-test-secret-at-least-16-chars"
MASTER_KEY="$(openssl rand -base64 32)"
WRONG_MASTER_KEY="$(openssl rand -base64 32)"

log() { echo "[drill] $*"; }

run_psql() {
  # Try as the app role first (CI's postgres service usually exposes this
  # directly); fall back to the postgres superuser via sudo for local dev
  # containers where app's auth isn't wired the same way.
  PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d postgres -c "$1" >/dev/null 2>&1 \
    || sudo -u postgres psql -c "$1" >/dev/null 2>&1
}

# --- fresh database -----------------------------------------------------
log "preparing fresh database ${DB_NAME}"
run_psql "DROP DATABASE IF EXISTS ${DB_NAME};"
run_psql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

export DATABASE_URL JWT_SECRET NODE_ENV=production DATABASE_SSL=false
export SUPABASE_URL="https://example.supabase.co" SUPABASE_KEY="dummy"
export ETHEREUM_RPC_SEPOLIA="https://rpc.sepolia.org" ETHEREUM_RPC_POLYGON="https://polygon-rpc.com"
export PORT

log "running migrations"
ENCRYPTION_MASTER_KEY="$MASTER_KEY" npm run migration:run >/tmp/drill-migrate.log 2>&1 \
  || { echo "migration failed"; cat /tmp/drill-migrate.log; exit 1; }

wait_healthy() {
  for i in $(seq 1 20); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/health" 2>/dev/null)" = "200" ]; then
      return 0
    fi
    sleep 1 2>/dev/null || true
  done
  return 1
}

wait_dead() {
  # curl's -w already prints the literal string "000" on connection failure
  # (no HTTP response) and still exits non-zero — do not also fall back to
  # `|| echo "000"` here, or both outputs concatenate into "000000", which
  # never matches and makes this loop unconditionally time out.
  for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/health" 2>/dev/null)
    [ "$code" = "000" ] && return 0
    sleep 1 2>/dev/null || true
  done
  return 1
}

# --- phase 1: create a wallet against a live process --------------------
# Started directly in this shell (not inside a function captured via
# command substitution) so $! is this script's own child, not a subshell's
# — a background job started inside $(...) can be orphaned the instant that
# subshell exits, which is exactly the kind of thing this drill is supposed
# to catch, not fall victim to.
log "starting process A"
ENCRYPTION_MASTER_KEY="$MASTER_KEY" node dist/main.js > /tmp/drill-server.log 2>&1 &
PID_A=$!
wait_healthy || { echo "process A never became healthy"; cat /tmp/drill-server.log; exit 1; }
log "process A healthy (pid $PID_A)"

USER_ID=$(node -e "console.log(require('crypto').randomUUID())")
run_psql_db() {
  PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c "$1" >/dev/null 2>&1 \
    || sudo -u postgres psql -d "$DB_NAME" -c "$1" >/dev/null 2>&1
}
run_psql_db "INSERT INTO users (id, email, \"emailVerified\", \"mfaEnabled\") VALUES ('${USER_ID}','drill@openprivy.io',true,false);"

TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:'${USER_ID}',email:'drill@openprivy.io'},'${JWT_SECRET}',{expiresIn:'10m'}))")

CREATE_RESP=$(curl -s -X POST "http://localhost:${PORT}/wallet/create" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"chain":"ethereum"}')
WALLET_ID=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$CREATE_RESP" 2>/dev/null || echo "")
WALLET_ADDRESS=$(node -e "console.log(JSON.parse(process.argv[1]).address)" "$CREATE_RESP" 2>/dev/null || echo "")

if [ -z "$WALLET_ID" ] || [ "$WALLET_ID" = "undefined" ]; then
  echo "wallet creation failed: $CREATE_RESP"
  kill -9 "$PID_A" 2>/dev/null || true
  exit 1
fi
log "created wallet ${WALLET_ID} address=${WALLET_ADDRESS}"

# --- phase 2: hard kill, no graceful shutdown ---------------------------
log "SIGKILL process A (pid $PID_A) — simulating a crashed/evicted pod"
kill -9 "$PID_A" 2>/dev/null || true
disown "$PID_A" 2>/dev/null || true
wait_dead || { echo "process A did not die"; exit 1; }
log "process A confirmed dead"

# --- phase 3: restart with the SAME master key (the real recovery path) --
log "starting process B with the correct master key"
ENCRYPTION_MASTER_KEY="$MASTER_KEY" node dist/main.js > /tmp/drill-server.log 2>&1 &
PID_B=$!
wait_healthy || { echo "process B never became healthy"; cat /tmp/drill-server.log; exit 1; }
log "process B healthy (pid $PID_B) — service itself recovers"

log "verifying custody recovery (correct master key — must PASS)"
if DATABASE_URL="$DATABASE_URL" NODE_ENV=production DATABASE_SSL=false \
   ETHEREUM_RPC_SEPOLIA="$ETHEREUM_RPC_SEPOLIA" ETHEREUM_RPC_POLYGON="$ETHEREUM_RPC_POLYGON" \
   SUPABASE_URL="$SUPABASE_URL" SUPABASE_KEY="$SUPABASE_KEY" \
   ENCRYPTION_MASTER_KEY="$MASTER_KEY" \
   DRILL_WALLET_ID="$WALLET_ID" DRILL_USER_ID="$USER_ID" DRILL_EXPECTED_ADDRESS="$WALLET_ADDRESS" \
   npx ts-node src/scripts/verify-custody-recovery.ts; then
  log "PASS: process B recovered custody and signed correctly for ${WALLET_ADDRESS}"
else
  echo "FAIL: custody did not survive the kill/restart with the correct master key"
  kill -9 "$PID_B" 2>/dev/null || true
  exit 1
fi

kill -9 "$PID_B" 2>/dev/null || true
disown "$PID_B" 2>/dev/null || true
wait_dead || true

# --- phase 4: negative control — wrong master key MUST fail -------------
log "verifying the drill is not vacuous: WRONG master key must fail to recover"
if DATABASE_URL="$DATABASE_URL" NODE_ENV=production DATABASE_SSL=false \
   ETHEREUM_RPC_SEPOLIA="$ETHEREUM_RPC_SEPOLIA" ETHEREUM_RPC_POLYGON="$ETHEREUM_RPC_POLYGON" \
   SUPABASE_URL="$SUPABASE_URL" SUPABASE_KEY="$SUPABASE_KEY" \
   ENCRYPTION_MASTER_KEY="$WRONG_MASTER_KEY" \
   DRILL_WALLET_ID="$WALLET_ID" DRILL_USER_ID="$USER_ID" DRILL_EXPECTED_ADDRESS="$WALLET_ADDRESS" \
   npx ts-node src/scripts/verify-custody-recovery.ts; then
  echo "FAIL: recovery succeeded with the WRONG master key — the drill is not meaningful"
  exit 1
else
  log "PASS: wrong master key correctly fails to recover (drill is non-vacuous)"
fi

log "RECOVERY DRILL PASSED"
