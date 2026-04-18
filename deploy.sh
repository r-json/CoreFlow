#!/bin/bash
# CoreFlow Deployment Script for Stellar Testnet
# Deploys the Soroban smart contract to Testnet
# 
# Prerequisites:
# - Stellar CLI installed (https://github.com/stellar/rs-soroban-cli)
# - Rust toolchain with wasm32 target
# - Freighter wallet setup with testnet address

set -e

echo "=========================================="
echo "CoreFlow Contract Deployment - Testnet"
echo "=========================================="

# Configuration
NETWORK="testnet"
CONTRACT_DIR="./contracts/core-flow"
WASM_BUILD_DIR="$CONTRACT_DIR/target/wasm32-unknown-unknown/release"
WASM_FILE="$WASM_BUILD_DIR/core_flow.wasm"
CONTRACT_NAME="core-flow"

# Step 1: Build contract
echo ""
echo "[1/4] Building Soroban contract..."
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release

if [ ! -f "$WASM_FILE" ]; then
  echo "Error: WASM file not found at $WASM_FILE"
  exit 1
fi

cd - > /dev/null

# Step 2: Optimize WASM (optional but recommended)
echo ""
echo "[2/4] Optimizing WASM binary..."
# wasm-opt -Oz -o "$WASM_FILE".optimized "$WASM_FILE" 2>/dev/null || echo "Note: wasm-opt not installed, skipping optimization"

# Step 3: Deploy contract
echo ""
echo "[3/4] Deploying contract to $NETWORK..."
echo ""
echo "Running: stellar contract deploy --network $NETWORK --source SOURCE_ACCOUNT_NAME_HERE --wasm $WASM_FILE"
echo ""
echo "IMPORTANT: Replace SOURCE_ACCOUNT_NAME_HERE with your funded Stellar testnet account name"
echo "Your Freighter wallet public key should be associated with this account"
echo ""
echo "Command to deploy:"
echo "stellar contract deploy \\"
echo "  --network $NETWORK \\"
echo "  --source <your-account-name> \\"
echo "  --wasm $WASM_FILE"
echo ""

# Uncomment the following and replace <your-account-name> with your actual account
# stellar contract deploy \
#   --network "$NETWORK" \
#   --source <your-account-name> \
#   --wasm "$WASM_FILE"

# Step 4: Output next steps
echo ""
echo "[4/4] Post-deployment steps:"
echo ""
echo "1. Copy the returned contract ID from the deployment output above"
echo "2. Update .env.local:"
echo "   NEXT_PUBLIC_STELLAR_CONTRACT_ID=<contract-id-from-deployment>"
echo ""
echo "3. Use a valid testnet address for NEXT_PUBLIC_STELLAR_READ_ADDRESS"
echo "   Example: NEXT_PUBLIC_STELLAR_READ_ADDRESS=GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJMqtbu7A5VKZXWV7NBVXCIS7"
echo ""
echo "4. Start the development server:"
echo "   npm run dev"
echo ""
echo "=========================================="
echo "Deployment Script Complete"
echo "=========================================="
