#!/bin/bash
# CoreFlow contract deploy + admin bootstrap.
#
# Builds the WASM, optimizes it, deploys to the chosen network, then (optionally)
# sets the contract admin so the circuit breaker / upgrade path is usable.
#
# Prerequisites:
#   - Stellar CLI            (https://github.com/stellar/stellar-cli)
#   - Rust + wasm32 target   (rustup target add wasm32-unknown-unknown)
#
# Usage:
#   NETWORK=testnet SOURCE=my-key ADMIN=GADMIN... ./deploy.sh
#     NETWORK : testnet | public        (default: testnet)
#     SOURCE  : funded stellar CLI identity used to sign (required to deploy)
#     ADMIN   : address to set as contract admin via init_admin (optional)
#
# Without SOURCE the script only builds + optimizes and prints the commands.

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-}"
ADMIN="${ADMIN:-}"
CONTRACT_DIR="./contracts/core-flow"
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/core_flow.wasm"

echo "== CoreFlow deploy (network=$NETWORK) =="

echo "[1/4] Building contract (release/wasm)…"
( cd "$CONTRACT_DIR" && cargo build --target wasm32-unknown-unknown --release )
[ -f "$WASM" ] || { echo "ERROR: WASM not found at $WASM"; exit 1; }

echo "[2/4] Optimizing WASM…"
if command -v stellar >/dev/null 2>&1; then
  stellar contract optimize --wasm "$WASM" || echo "  (optimize skipped)"
else
  echo "  stellar CLI not found — skipping optimize"
fi

if [ -z "$SOURCE" ]; then
  echo "[3/4] No SOURCE provided — dry run. To deploy:"
  echo "  stellar contract deploy --wasm $WASM --source <key> --network $NETWORK"
  echo "[4/4] Then set admin:"
  echo "  stellar contract invoke --id <CONTRACT_ID> --source <key> --network $NETWORK -- init_admin --admin <ADMIN>"
  exit 0
fi

echo "[3/4] Deploying…"
CONTRACT_ID="$(stellar contract deploy --wasm "$WASM" --source "$SOURCE" --network "$NETWORK")"
echo "  Deployed: $CONTRACT_ID"

if [ -n "$ADMIN" ]; then
  echo "[4/4] Setting admin ($ADMIN)…"
  stellar contract invoke --id "$CONTRACT_ID" --source "$SOURCE" --network "$NETWORK" \
    -- init_admin --admin "$ADMIN"
else
  echo "[4/4] No ADMIN provided — skipping init_admin (set it before mainnet use)."
fi

echo ""
echo "Done. Set NEXT_PUBLIC_STELLAR_CONTRACT_ID=$CONTRACT_ID in your environment."
