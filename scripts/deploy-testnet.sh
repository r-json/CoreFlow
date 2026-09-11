#!/usr/bin/env bash
#
# Deploy CoreFlow v2 to Stellar TESTNET.
#
# This script is deliberately testnet-only. CoreFlow v1 remains deployed on
# Mainnet and is NOT touched, repointed, or upgraded by anything here — v2's
# security improvements are not on Mainnet, and nothing in this repo should
# imply otherwise.
#
# The script refuses to proceed unless the WASM is built with COREFLOW_ADMIN
# pinned. An unpinned build is vulnerable to `init_admin` front-running: deploy
# and initialize cannot share a transaction (Stellar allows one Soroban
# operation per transaction), so anyone watching the ledger can claim admin in
# between and then upgrade the contract to code that drains every escrow.
#
# Usage:
#   ADMIN_IDENTITY=coreflow-v2-admin ORACLE_PUBKEY=<64 hex> ./scripts/deploy-testnet.sh
#
set -euo pipefail

NETWORK="testnet"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
CONTRACT_DIR="contracts/core-flow"
WASM="$CONTRACT_DIR/target/wasm32v1-none/release/core_flow.wasm"
OUT_DIR="docs/evidence"
OUT="$OUT_DIR/testnet-v2-deployment.json"

ADMIN_IDENTITY="${ADMIN_IDENTITY:-coreflow-v2-admin}"
ORACLE_PUBKEY="${ORACLE_PUBKEY:-}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v stellar >/dev/null || die "stellar CLI not found. See https://developers.stellar.org/docs/tools/cli"
[ -n "$ORACLE_PUBKEY" ] || die "ORACLE_PUBKEY is required (64 hex chars). Get it with: node scripts/oracle-cli.mjs pubkey"
[[ "$ORACLE_PUBKEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "ORACLE_PUBKEY must be exactly 64 hex characters."

ADMIN_ADDRESS="$(stellar keys address "$ADMIN_IDENTITY")"
[[ "$ADMIN_ADDRESS" =~ ^G[A-Z2-7]{55}$ ]] || die "Could not resolve identity '$ADMIN_IDENTITY' to a G-address."

log "CoreFlow v2 → Stellar Testnet"
echo "  admin identity : $ADMIN_IDENTITY"
echo "  admin address  : $ADMIN_ADDRESS"
echo "  oracle pubkey  : $ORACLE_PUBKEY"

# ── 1. Build with the admin pinned into the WASM ────────────────────────────
log "Building WASM with COREFLOW_ADMIN pinned"
(
  cd "$CONTRACT_DIR"
  COREFLOW_ADMIN="$ADMIN_ADDRESS" cargo build --release --target wasm32v1-none
)
[ -f "$WASM" ] || die "Build produced no WASM at $WASM"

# The pin must be physically present in the binary. Building with the env var
# set is not evidence that the compiler used it — a cached artifact from an
# unpinned build would look identical here otherwise.
if ! grep -qa "$ADMIN_ADDRESS" "$WASM"; then
  die "COREFLOW_ADMIN is not baked into the WASM. Refusing to deploy an unpinned build.
Try: (cd $CONTRACT_DIR && cargo clean) and re-run."
fi
echo "  verified: admin pin present in WASM"

WASM_SHA256="$(sha256sum "$WASM" | cut -d' ' -f1)"
WASM_BYTES="$(stat -c%s "$WASM")"
echo "  wasm sha256    : $WASM_SHA256"
echo "  wasm size      : $WASM_BYTES bytes"

# ── 2. Deploy ───────────────────────────────────────────────────────────────
log "Deploying to $NETWORK"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ADMIN_IDENTITY" \
  --network "$NETWORK" 2>/dev/null | tail -1)"
[[ "$CONTRACT_ID" =~ ^C[A-Z2-7]{55}$ ]] || die "Deploy did not return a contract id (got: '$CONTRACT_ID')"
echo "  contract id    : $CONTRACT_ID"

inv() { stellar contract invoke --id "$CONTRACT_ID" --source "$ADMIN_IDENTITY" --network "$NETWORK" -- "$@" 2>/dev/null; }

# ── 3. Claim admin ──────────────────────────────────────────────────────────
# The pin makes this race-proof: any other address calling init_admin first is
# rejected with AdminMismatch (#20), so there is nothing to win by front-running.
log "Initializing admin"
inv init_admin --admin "$ADMIN_ADDRESS" >/dev/null
echo "  init_admin done"

# ── 4. Register the oracle key ──────────────────────────────────────────────
log "Registering oracle signing key"
inv register_oracle_key --pubkey "$ORACLE_PUBKEY" >/dev/null
echo "  register_oracle_key done"

# ── 5. Verify the deployed state, rather than assuming the calls worked ─────
log "Verifying deployed state"
GOT_EXPECTED_ADMIN="$(inv expected_admin | tr -d '"')"
GOT_ADMIN="$(inv get_admin | tr -d '"')"
GOT_PAUSED="$(inv is_paused)"
GOT_ORACLE="$(inv is_oracle_key_registered --pubkey "$ORACLE_PUBKEY")"

echo "  expected_admin (build pin) : $GOT_EXPECTED_ADMIN"
echo "  get_admin      (on-chain)  : $GOT_ADMIN"
echo "  is_paused                  : $GOT_PAUSED"
echo "  oracle key registered      : $GOT_ORACLE"

[ "$GOT_EXPECTED_ADMIN" = "$ADMIN_ADDRESS" ] || die "WASM admin pin does not match the deploying admin."
[ "$GOT_ADMIN" = "$ADMIN_ADDRESS" ]          || die "On-chain admin is not the expected address."
[ "$GOT_PAUSED" = "false" ]                  || die "Contract deployed in a paused state."
[ "$GOT_ORACLE" = "true" ]                   || die "Oracle key is not registered."

# ── 6. Record the deployment ────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
cat > "$OUT" <<JSON
{
  "version": "v2",
  "network": "$NETWORK",
  "networkPassphrase": "$NETWORK_PASSPHRASE",
  "contractId": "$CONTRACT_ID",
  "wasmSha256": "$WASM_SHA256",
  "wasmBytes": $WASM_BYTES,
  "proofSchema": "CFWP-v2",
  "adminAddress": "$ADMIN_ADDRESS",
  "adminPinnedInWasm": true,
  "oraclePublicKey": "$ORACLE_PUBKEY",
  "oracleKeyRegistered": true,
  "paused": false,
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "explorer": "https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID",
  "note": "CoreFlow v2, Testnet only. v1 remains deployed separately on Mainnet and is not affected by this deployment."
}
JSON

log "Deployed and verified"
cat "$OUT"
echo
echo "Set in your environment:"
echo "  NEXT_PUBLIC_STELLAR_NETWORK=testnet"
echo "  NEXT_PUBLIC_STELLAR_CONTRACT_ID=$CONTRACT_ID"
