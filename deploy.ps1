# CoreFlow Deployment Script for Stellar Testnet (Windows PowerShell)
# Deploys the Soroban smart contract to Testnet

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "CoreFlow Contract Deployment - Testnet" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Configuration
$NETWORK = "testnet"
$CONTRACT_DIR = "./contracts/core-flow"
$WASM_BUILD_DIR = "$CONTRACT_DIR/target/wasm32-unknown-unknown/release"
$WASM_FILE = "$WASM_BUILD_DIR/core_flow.wasm"
$CONTRACT_NAME = "core-flow"

# Step 1: Build contract
Write-Host ""
Write-Host "[1/4] Building Soroban contract..." -ForegroundColor Yellow
Push-Location $CONTRACT_DIR
cargo build --target wasm32-unknown-unknown --release

if (!(Test-Path $WASM_FILE)) {
  Write-Host "Error: WASM file not found at $WASM_FILE" -ForegroundColor Red
  exit 1
}

Pop-Location

# Step 2: Check Stellar CLI
Write-Host ""
Write-Host "[2/4] Verifying Stellar CLI..." -ForegroundColor Yellow
try {
  $version = stellar --version
  Write-Host "Found: $version" -ForegroundColor Green
} catch {
  Write-Host "Error: Stellar CLI not found. Install from https://github.com/stellar/rs-soroban-cli" -ForegroundColor Red
  exit 1
}

# Step 3: Deploy contract
Write-Host ""
Write-Host "[3/4] Deployment Instructions:" -ForegroundColor Yellow
Write-Host ""
Write-Host "Run the following command in your terminal:" -ForegroundColor Cyan
Write-Host ""
Write-Host "stellar contract deploy \" -ForegroundColor White
Write-Host "  --network testnet \" -ForegroundColor White
Write-Host "  --source <your-account-name> \" -ForegroundColor White
Write-Host "  --wasm $WASM_FILE" -ForegroundColor White
Write-Host ""
Write-Host "IMPORTANT:" -ForegroundColor Red
Write-Host "- Replace <your-account-name> with your Stellar testnet account name configured with Stellar CLI" -ForegroundColor Yellow
Write-Host "- Your Freighter wallet public key should be associated with this account" -ForegroundColor Yellow
Write-Host "- Ensure the account has enough balance for deployment fees" -ForegroundColor Yellow
Write-Host ""

# Step 4: Output next steps
Write-Host "[4/4] Post-deployment steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. After deployment completes, copy the CONTRACT_ID from the output" -ForegroundColor Green
Write-Host ""
Write-Host "2. Update .env.local with:" -ForegroundColor Green
Write-Host "   NEXT_PUBLIC_STELLAR_CONTRACT_ID=<your-contract-id>" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. Ensure you have a valid testnet address in .env.local:" -ForegroundColor Green
Write-Host "   NEXT_PUBLIC_STELLAR_READ_ADDRESS=GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJMqtbu7A5VKZXWV7NBVXCIS7" -ForegroundColor Cyan
Write-Host ""
Write-Host "4. Start the development server:" -ForegroundColor Green
Write-Host "   npm run dev" -ForegroundColor Cyan
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Deployment Script Complete" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
