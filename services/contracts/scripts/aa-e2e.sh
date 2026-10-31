#!/usr/bin/env bash
# Backend UserOpService -> real EntryPoint v0.7 on a local Hardhat chain.
# Starts a node, deploys EntryPoint + OpenPrivy factory/paymaster, runs the
# backend's on-chain integration test, and always stops the node.
set -euo pipefail
cd "$(dirname "$0")/.."
CONTRACTS_DIR=$(pwd)
BACKEND_DIR="$CONTRACTS_DIR/../backend"
ENV_FILE=$(mktemp)
NODE_LOG=$(mktemp)

# Own process group, so cleanup reaches the node behind npx's wrapper processes.
setsid npx hardhat node >"$NODE_LOG" 2>&1 &
NODE_PID=$!
trap 'kill -- -$NODE_PID 2>/dev/null || true; rm -f "$ENV_FILE" "$NODE_LOG"' EXIT

for _ in $(seq 1 60); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      http://127.0.0.1:8545 | grep -q result; then break; fi
  sleep 1
done

AA_ENV_OUT="$ENV_FILE" npx hardhat run scripts/deploy-local-aa.ts --network localhost
set -a; . "$ENV_FILE"; set +a

cd "$BACKEND_DIR"
AA_RPC_URL=http://127.0.0.1:8545 npx jest --testPathIgnorePatterns='/node_modules/' \
  --runTestsByPath test/integration/userop-hash.integration.test.ts
