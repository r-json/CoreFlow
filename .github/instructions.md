# CoreFlow — Project Instructions

> **On-Chain Accounts Payable for Remote Teams**
> Soroban Smart Contract + Next.js 14 Dashboard · Stellar Philippines Bootcamp 2026

---

## Project Overview

CoreFlow is a decentralized accounts payable platform built on the Stellar blockchain. It replaces traditional invoice-and-wire-transfer workflows with an on-chain escrow system featuring multi-signature approvals, oracle-verified time tracking, and automated payment releases.

| Layer | Technology |
|---|---|
| Smart Contract | Rust + Soroban SDK (compiled to WASM) |
| Frontend | Next.js 14 (App Router) + TypeScript |
| Styling | Tailwind CSS 3 (dark-mode glassmorphism) |
| Wallet | Stellar Freighter (browser extension) |
| Blockchain | Stellar Testnet / Mainnet (Soroban) |

---

## Current Status

- [x] Monorepo directory structure
- [x] Soroban smart contract with full implementation
- [x] Unit tests (happy path + failure scenarios)
- [x] Next.js 14 frontend with App Router
- [x] Stellar configuration module (Freighter Guide Section 4)
- [x] CoreFlowClient with simulate / submit pattern
- [x] Dashboard UI with escrow cards, stats, and activity feed
- [x] Freighter wallet connect / disconnect
- [x] Deployment scripts (Linux, macOS, Windows)
- [x] Design system documentation (DESIGN_SYSTEM.md)
- [x] Implementation guide with before/after examples
- [x] Comprehensive README with project identity

---

## Workflow (How CoreFlow Works)

```
Initialize Escrow → Submit Hours Proof → Manager Approve → Finance Approve → Finalize Payment
```

| Step | Actor | Contract Function | Description |
|---|---|---|---|
| 1 | Manager | `initialize_multi_sig_escrow()` | Create escrow with worker addresses and payment schedules |
| 2 | Worker + Oracle | `submit_hours_proof()` | Submit Ed25519-signed hours data from time-tracking system |
| 3 | Manager | `manager_approve()` | Manager reviews and approves via Freighter wallet |
| 4 | Finance | `finance_approve()` | Finance reviews budget and approves via Freighter wallet |
| 5 | Manager | `finalize_payment()` | Both approvals confirmed → USDC released to worker |

---

## Key Files

| File | Purpose |
|---|---|
| `contracts/core-flow/src/lib.rs` | Soroban smart contract (escrow, approvals, oracle) |
| `contracts/core-flow/src/test.rs` | Contract unit tests |
| `src/lib/config.ts` | Stellar network, wallet, and RPC configuration |
| `src/lib/contracts.ts` | CoreFlowClient (simulate + submit methods) |
| `src/app/dashboard/page.tsx` | Main dashboard UI (stats, escrow cards, activity feed) |
| `src/components/EscrowCard.tsx` | Escrow card with approval timeline and actions |
| `src/components/WalletButton.tsx` | Freighter wallet connect/disconnect button |
| `src/components/TransactionFeed.tsx` | On-chain transaction activity feed |
| `deploy.sh` / `deploy.ps1` | Contract deployment scripts (Unix / Windows) |
| `.env.example` | Environment variable template |

---

## Quick Start

```bash
# 1. Install frontend dependencies
npm install

# 2. Install Rust contract dependencies
cd contracts/core-flow && cargo fetch && cd ../..

# 3. Configure environment
cp .env.example .env.local
# Edit .env.local with your Stellar testnet addresses

# 4. Build the smart contract
npm run contract:build

# 5. Run contract tests
npm run contract:test

# 6. Deploy to testnet (Linux/Mac)
bash deploy.sh

# 6. Deploy to testnet (Windows)
.\deploy.ps1

# 7. Start the development server
npm run dev
# Open http://localhost:3000/dashboard
```

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Build production bundle |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run contract:build` | Build Soroban contract (Rust → WASM) |
| `npm run contract:test` | Run contract unit tests |

---

## Architecture Highlights

### Smart Contract
- Multi-output payment schedule support (`Vec<PaymentSchedule>`)
- Conditional multi-signature approval (manager + finance)
- Oracle integration pattern with Ed25519 signature validation
- Robust error handling with custom error enums (7 error codes)

### Frontend Integration
- Freighter wallet connection via `STELLAR_CONFIG.freighter`
- Read-only simulation address (`NEXT_PUBLIC_STELLAR_READ_ADDRESS`)
- Simulate → Submit pattern for all write transactions
- Real-time approval status tracking with transaction feed

### Environment Configuration
- Testnet and Mainnet support (single env var toggle)
- Configuration module following Freighter Guide Section 4
- RPC endpoint auto-selection based on network
- Wallet timeout configuration

---

## Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `NEXT_PUBLIC_STELLAR_NETWORK` | Network selection (`testnet` / `public`) | Yes |
| `NEXT_PUBLIC_STELLAR_READ_ADDRESS` | Read-only address for simulations | Yes |
| `NEXT_PUBLIC_STELLAR_CONTRACT_ID` | Deployed contract address | Yes |
| `NEXT_PUBLIC_FREIGHTER_TIMEOUT` | Wallet timeout in ms (default: 5000) | No |

---

See **[README.md](../README.md)** for the complete documentation, design system, and troubleshooting guide.
