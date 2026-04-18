# CoreFlow - On-Chain Accounts Payable

## Overview

CoreFlow is a complete implementation of an **On-Chain Accounts Payable (AP) Workflow** using Soroban smart contracts and Next.js 14. It demonstrates multi-signature approval flows, oracle integration patterns, and Stellar Freighter wallet integration following the **Stellar Freighter Integration Guide**.

### Key Features

- **Soroban Smart Contract** (Rust): Multi-signature escrow with payment schedules
- **Next.js 14 Frontend** (TypeScript): Dashboard with Freighter wallet integration
- **Stellar Testnet Ready**: Deploy-ready configuration for Stellar Testnet
- **Comprehensive Testing**: Unit tests covering happy path and failure scenarios
- **Best Practices**: Follows Stellar Bootcamp 2026 patterns and guidelines

---

## Project Structure

```
coreflow/
├── contracts/
│   └── core-flow/
│       ├── src/
│       │   ├── lib.rs           # Smart contract implementation
│       │   └── test.rs          # Unit tests
│       └── Cargo.toml           # Rust dependencies
├── src/
│   ├── app/
│   │   ├── layout.tsx           # Root layout
│   │   ├── globals.css          # Global styles
│   │   └── dashboard/
│   │       └── page.tsx         # Dashboard UI
│   ├── lib/
│   │   ├── config.ts            # Stellar configuration (Section 4)
│   │   └── contracts.ts         # CoreFlowClient class
│   └── components/
│       ├── Button.tsx           # shadcn/ui Button
│       ├── Card.tsx             # shadcn/ui Card
│       └── Alert.tsx            # shadcn/ui Alert
├── .env.example                 # Environment template
├── .env.local                   # Local configuration
├── package.json                 # Frontend dependencies
├── tsconfig.json                # TypeScript config
├── next.config.ts               # Next.js config
├── tailwind.config.js           # Tailwind CSS config
├── deploy.sh                    # Linux/Mac deployment script
├── deploy.ps1                   # Windows deployment script
└── README.md                    # This file
```

---

## Getting Started

### Prerequisites

- **Node.js** 18+ and npm/yarn
- **Rust** with wasm32 target: `rustup target add wasm32-unknown-unknown`
- **Stellar CLI**: https://github.com/stellar/rs-soroban-cli
- **Freighter Wallet**: https://www.freighter.app/

### 1. Install Frontend Dependencies

```bash
npm install
```

### 2. Build the Rust Smart Contract

```bash
npm run contract:build
```

### 3. Configure Environment Variables

Copy and configure `.env.local`:

```bash
cp .env.example .env.local
```

Update with your values:

```env
# The network to connect to (testnet or public)
NEXT_PUBLIC_STELLAR_NETWORK=testnet

# CRITICAL: Read-only address for contract simulations (from Stellar Freighter Integration Guide - Section 3)
# This address does NOT need signing authority
# Use any valid Testnet address
NEXT_PUBLIC_STELLAR_READ_ADDRESS=GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJMqtbu7A5VKZXWV7NBVXCIS7

# Your deployed contract ID (obtained after deployment)
NEXT_PUBLIC_STELLAR_CONTRACT_ID=CAU3FQTWCAFJF4XFVRXSEPWRPBCVHDSRBSCPTM75HJFDZD5XQQQY47A4
```

---

## Smart Contract (Soroban)

### Architecture

The `CoreFlowContract` implements an escrow system with:

1. **Payment Schedules**: Support for multiple payments to workers
2. **Multi-Signature Approval**: Requires both manager and finance approvals
3. **Oracle Integration**: Simulates time-tracking oracle with Ed25519 signature validation
4. **State Management**: Persistent storage of escrow and payment data

### Key Functions

```rust
// Initialize multi-signature escrow with payment schedules
initialize_multi_sig_escrow(
    manager: Address,
    finance_approver: Address,
    payments: Vec<PaymentSchedule>,
) -> Result<u32, u32>

// Submit hours proof with oracle signature
submit_hours_proof(
    escrow_id: u32,
    payment_id: u32,
    hours_logged: i128,
    signature: Bytes,
) -> Result<(), u32>

// Manager approval
manager_approve(escrow_id: u32) -> Result<(), u32>

// Finance approval
finance_approve(escrow_id: u32) -> Result<(), u32>

// Finalize payment (requires both approvals)
finalize_payment(escrow_id: u32) -> Result<Vec<PaymentSchedule>, u32>

// Get escrow details
get_escrow(escrow_id: u32) -> Result<CoreFlowEscrow, u32>
```

### Error Handling

```rust
enum ContractError {
    AlreadyApproved = 1,
    Unauthorized = 2,
    InvalidOracleSignature = 3,
    InvalidPaymentId = 4,
    InsufficientApprovals = 5,
    PaymentAlreadyFinalized = 6,
    InvalidAmount = 7,
}
```

### Testing

Run contract tests:

```bash
npm run contract:test
```

Test coverage includes:
- ✅ Happy path: Initialize → Manager approve → Finance approve → Finalize
- ✅ Invalid oracle signature rejection
- ✅ Finalization without both approvals fails
- ✅ Double approval prevention

---

## Frontend (Next.js 14)

### Configuration (Section 4)

The [src/lib/config.ts](src/lib/config.ts) module provides:

- Network configuration (Testnet/Mainnet)
- Contract address and ABI
- Freighter wallet integration
- RPC endpoint management

**Key Feature**: `NEXT_PUBLIC_STELLAR_READ_ADDRESS` for read-only simulations (Section 3)

### CoreFlowClient Class

The [src/lib/contracts.ts](src/lib/contracts.ts) implements:

```typescript
// Simulate manager approval (uses NEXT_PUBLIC_STELLAR_READ_ADDRESS)
simulateManagerApprove(escrowId: number): Promise<SimulateResult>

// Submit manager approval via Freighter
submitManagerApprove(escrowId: number): Promise<SubmitResult>

// Simulate finance approval
simulateFinanceApprove(escrowId: number): Promise<SimulateResult>

// Submit finance approval via Freighter
submitFinanceApprove(escrowId: number): Promise<SubmitResult>

// Get escrow details
getEscrow(escrowId: number): Promise<any>
```

### Dashboard UI

The [src/app/dashboard/page.tsx](src/app/dashboard/page.tsx) features:

- **Wallet Connection**: Connect Freighter wallet
- **Payment Cards**: Display pending payments with approval status
- **Approval Buttons**: Manager and Finance approval actions
- **Transaction Status**: Display transaction hashes and real-time feedback
- **Error Handling**: User-friendly error messages

---

## Deployment to Stellar Testnet

### Step 1: Fund Your Testnet Account

1. Open https://friendbot.stellar.org
2. Enter your Freighter wallet public key
3. Verify funding: https://stellar.expert/explorer/testnet

### Step 2: Configure Stellar CLI

```bash
stellar keys generate --name coreflow
```

### Step 3: Deploy the Contract

**On Linux/Mac:**
```bash
bash deploy.sh
```

**On Windows (PowerShell):**
```powershell
.\deploy.ps1
```

**Manual deployment:**
```bash
stellar contract deploy \
  --network testnet \
  --source coreflow \
  --wasm ./contracts/core-flow/target/wasm32-unknown-unknown/release/core_flow.wasm
```

### Step 4: Update Configuration

Copy the returned contract ID and update `.env.local`:

```env
NEXT_PUBLIC_STELLAR_CONTRACT_ID=<your-contract-id>
```

---

## Development

### Start Development Server

```bash
npm run dev
```

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

### Build for Production

```bash
npm run build
npm run start
```

### Lint

```bash
npm run lint
```

---

## Environment Variables Reference

### Section 3: Network Configuration

| Variable | Purpose | Required |
|----------|---------|----------|
| `NEXT_PUBLIC_STELLAR_NETWORK` | Network selection (testnet/public) | Yes |
| `NEXT_PUBLIC_STELLAR_READ_ADDRESS` | Read-only address for simulations | Yes |
| `NEXT_PUBLIC_STELLAR_CONTRACT_ID` | Deployed contract address | Yes |

All `NEXT_PUBLIC_*` variables are safe to expose client-side.

---

## References

- **Stellar Freighter Integration Guide**: https://github.com/armlynobinguar/Stellar-Bootcamp-2026/blob/main/STELLAR_FREIGHTER_INTEGRATION_GUIDE.md
- **Soroban Documentation**: https://developers.stellar.org/docs/learn/soroban
- **js-stellar-sdk**: https://github.com/stellar/py-stellar-base
- **Next.js Documentation**: https://nextjs.org/docs

---

## Architecture Decisions

### 1. Multi-Signature Escrow

The contract requires both `manager` and `finance_approver` to sign off before payment finalization, ensuring proper governance.

### 2. Read-Only Simulations

Following the Freighter Integration Guide (Section 3), simulations use `NEXT_PUBLIC_STELLAR_READ_ADDRESS` which:
- Does NOT mutate contract state
- Does NOT require signing authority
- Allows preview of transactions before submission
- Improves UX by providing fee estimates

### 3. Payment Schedules

Support for `Vec<PaymentSchedule>` enables:
- Multiple payments to same worker
- Recurring payment patterns
- Batch processing

### 4. Oracle Integration Pattern

`submit_hours_proof` demonstrates oracle integration with:
- Ed25519 signature validation
- External data integration (time-tracking systems)
- State mutation from oracle data

---

## Security Considerations

1. **Private Keys**: Never commit `.env.local` or private keys
2. **Freighter**: Always verify transaction details before signing
3. **Contract Audits**: This is a bootcamp project. Conduct security audits before mainnet deployment
4. **Rate Limiting**: Consider adding rate limits for API endpoints in production

---

## Troubleshooting

### Contract Build Fails
```bash
# Ensure wasm32 target is installed
rustup target add wasm32-unknown-unknown

# Clear cargo cache
cargo clean
```

### Freighter Connection Issues
- Ensure Freighter is installed: https://www.freighter.app/
- Switch to Testnet in Freighter settings
- Refresh the browser page

### Transaction Simulation Fails
- Verify `NEXT_PUBLIC_STELLAR_READ_ADDRESS` is valid and funded
- Check network selection matches Freighter wallet network
- Review contract deployment status

---

## Design System & Modern UI Implementation

### 2024/2025 Modern Dark-Mode Aesthetic

The CoreFlow dashboard implements cutting-edge dark-mode design principles optimized for Web3/fintech applications. 

**📖 Complete Guides:**

1. **[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)** - Comprehensive design system with:
   - Color palette (WCAG AA verified contrast)
   - Glassmorphism + depth techniques
   - Typography hierarchy system
   - Complete component patterns
   - Shadow elevation scale
   - Animation guidelines

2. **[IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md)** - Practical before/after examples:
   - Metric cards (stats display)
   - Activity feed items (transaction cards)
   - Data grids (escrow details)
   - Approval timelines (status checklists)
   - Full card containers
   - Button states

### Quick Reference

**🎨 Color Palette:**
- **Background:** `slate-950` (#0f172a) with black-green gradient
- **Surfaces:** `slate-900/800` with glassmorphism + `backdrop-blur-lg`
- **Primary Accent:** `emerald-500` (#10b981) for CTAs, success, highlights
- **Status Colors:** Amber (pending), Blue (action required), Red (error)
- **Text:** `slate-100` (primary), `slate-300` (secondary), `slate-400` (tertiary)

**✅ Accessibility (All WCAG AA+):**
- `slate-100` on `slate-950` = 15.2:1 contrast ✅ AAA
- `slate-300` on `slate-900` = 8.1:1 contrast ✅ AA
- `emerald-400` on `slate-950` = 9.3:1 contrast ✅ AAA
- `amber-400` on `slate-950` = 10.5:1 contrast ✅ AAA
- Color + icons for status (not color-only)
- Keyboard focus rings included

**🔧 Key Techniques:**

1. **Glassmorphism**
   ```css
   backdrop-blur-lg bg-gradient-to-br from-slate-800/40 via-slate-800/30 to-emerald-900/20
   ```

2. **Hover Elevation**
   ```css
   hover:border-emerald-500/40 hover:shadow-2xl hover:shadow-emerald-900/20 transition-all duration-300
   ```

3. **Gradient Text (Numbers)**
   ```css
   text-3xl font-bold bg-gradient-to-r from-blue-600 to-slate-400 bg-clip-text text-transparent
   ```

4. **Color-Coded Boxes**
   ```css
   /* Blue for neutral/total */
   from-blue-900/20 border-blue-500/20
   
   /* Amber for pending/warning */
   from-amber-900/20 border-amber-500/20
   
   /* Emerald for success/complete */
   from-emerald-900/20 border-emerald-500/20
   ```

**🎯 Font:** Outfit (geometric modern sans-serif, similar to Cerebri Sans)
- Weights: 400, 500, 600, 700
- Typography scale in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#typography--hierarchy-system)

---
