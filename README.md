<div align="center">

<img src="public/logo-readme.png" alt="CoreFlow Logo" width="250" />

# CoreFlow

### On-Chain Accounts Payable for Remote Teams

[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-7C3AED?style=for-the-badge&logo=stellar&logoColor=white)](https://stellar.org)
[![Soroban Smart Contract](https://img.shields.io/badge/Soroban-Smart%20Contract-10B981?style=for-the-badge)](https://soroban.stellar.org)
[![Next.js 14](https://img.shields.io/badge/Next.js-14-000000?style=for-the-badge&logo=next.js&logoColor=white)](https://nextjs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B?style=for-the-badge)](LICENSE)

<br />

**CoreFlow** is a decentralized accounts payable platform that brings **multi-signature escrow**, **oracle-verified time tracking**, and **automated payment releases** to the Stellar blockchain — purpose-built for remote teams and distributed organizations.

<br />

[Getting Started](#-getting-started) · [How It Works](#-how-it-works) · [Smart Contract](#-smart-contract-soroban) · [Frontend](#-frontend-nextjs-14) · [Deploy](#-deployment-to-stellar-testnet) · [Design System](#-design-system)

</div>

---

## 📋 Table of Contents

- [The Problem](#-the-problem)
- [The Solution](#-the-solution)
- [Target Users](#-target-users)
- [Core Features](#-core-features)
- [Tech Stack](#%EF%B8%8F-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [How It Works](#-how-it-works)
- [Smart Contract (Soroban)](#-smart-contract-soroban)
- [Frontend (Next.js 14)](#-frontend-nextjs-14)
- [Deployment to Stellar Testnet](#-deployment-to-stellar-testnet)
- [Environment Variables](#-environment-variables)
- [Development](#-development)
- [Architecture Decisions](#-architecture-decisions)
- [Design System](#-design-system)
- [Security Considerations](#-security-considerations)
- [Troubleshooting](#-troubleshooting)
- [References](#-references)

---

## The Problem

The shift towards global remote work has exposed critical inefficiencies in traditional B2B cross-border payment infrastructure. While the global cross-border payment market is projected to reach $320 trillion by 2032 (The Payments Association, 2024), the systems supporting these transactions remain slow, costly, and opaque. 

Organizations paying international contractors face three primary challenges:

- **High Costs and Processing Delays:** Traditional international transfers rely on complex correspondent banking chains. This results in processing times of 3 to 5 business days and transaction costs frequently exceeding 3-6% of the principal amount (ACI Worldwide, 2024).
- **Operational Friction and Manual Errors:** Manual invoice processing and approval chains lead to high rates of non-straight-through processing (STP). Resolving these administrative delays and repair errors costs organizations between $15 and $40 per transaction (SRM, 2024).
- **Lack of Transparency and Trust:** Traditional workflows lack immutable audit trails, leaving finance teams vulnerable to invoice fraud and remote workers with zero visibility into payment statuses. Alarmingly, 79% of surveyed organizations report experiencing B2B payment fraud (Convera, 2024).

These structural inefficiencies necessitate a shift toward decentralized, automated escrow systems that guarantee cryptographic proof of work and near-instant settlement.

---

## 🟢 The Solution

**CoreFlow** replaces the legacy AP workflow with an **on-chain escrow system** on Stellar:

| Legacy Process | CoreFlow |
|---|---|
| Email-based approval chains | Multi-signature smart contract approvals |
| Manual time tracking | Oracle-verified hours with Ed25519 signatures |
| 3–5 day bank transfers | Near-instant USDC settlement on Stellar |
| Spreadsheet audit trails | Immutable on-chain transaction history |
| Opaque payment status | Real-time dashboard with live status tracking |

> **In short:** Workers submit verified hours → Managers and Finance approve on-chain → Payment is released automatically. Trustless. Transparent. Fast.

---

## 🎯 Target Users

| User | Role |
|---|---|
| **Remote-first startups** | Pay distributed teams across borders without bank friction |
| **DAOs & Web3 organizations** | Govern treasury payouts with multi-sig approval flows |
| **Freelancer collectives** | Transparent escrow for milestone-based contracts |
| **Finance teams** | Auditable, compliant payment workflows with full on-chain history |

---

## ✨ Core Features

| Feature | Description |
|---|---|
| 🔐 **Multi-Signature Escrow** | Requires both Manager and Finance approval before any payment is released |
| 🧾 **Oracle-Verified Time Tracking** | Ed25519-signed hours proof from time-tracking systems (oracle pattern) |
| 💳 **Payment Schedules** | Support for multiple workers, recurring payments, and batch processing |
| 🏦 **Freighter Wallet Integration** | Native Stellar wallet connect with simulate-before-submit UX |
| 📊 **Real-Time Dashboard** | Live payment status, approval progress, and transaction feed |
| ✅ **Read-Only Simulations** | Preview transaction costs and results without mutating chain state |
| 🌐 **Testnet & Mainnet Ready** | One config toggle to switch between networks |

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Smart Contract** | Rust + Soroban SDK | On-chain escrow logic, multi-sig, oracle verification |
| **Frontend** | Next.js 14 (App Router) | Dashboard UI with server/client components |
| **Styling** | Tailwind CSS 3 | Dark-mode glassmorphism design system |
| **Wallet** | Stellar Freighter | Browser extension for transaction signing |
| **Blockchain** | Stellar Network (Soroban) | Fast, low-cost smart contract execution |
| **Components** | shadcn/ui + Lucide Icons | Accessible, composable UI primitives |
| **Language** | TypeScript | Type-safe frontend development |

---

## 📁 Project Structure

```
coreflow/
├── contracts/
│   └── core-flow/
│       ├── src/
│       │   ├── lib.rs              # Smart contract implementation
│       │   └── test.rs             # Unit tests (happy path + failure cases)
│       ├── Cargo.toml              # Rust dependencies
│       └── Cargo.lock
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout (Outfit font, metadata)
│   │   ├── globals.css             # Global styles + design tokens
│   │   └── dashboard/
│   │       └── page.tsx            # Main dashboard UI
│   ├── lib/
│   │   ├── config.ts               # Stellar network & wallet config
│   │   └── contracts.ts            # CoreFlowClient (simulate + submit)
│   └── components/
│       ├── WalletButton.tsx         # Freighter wallet connect/disconnect
│       ├── EscrowCard.tsx           # Payment escrow card with approvals
│       ├── TransactionFeed.tsx      # Activity feed (on-chain transactions)
│       ├── Button.tsx               # Styled button component
│       ├── Card.tsx                 # Glassmorphism card container
│       └── Alert.tsx                # Status alert component
├── .env.example                     # Environment variable template
├── deploy.sh                        # Linux/Mac deployment script
├── deploy.ps1                       # Windows deployment script
├── DESIGN_SYSTEM.md                 # Complete design system documentation
├── IMPLEMENTATION_GUIDE.md          # Component before/after examples
├── package.json                     # Frontend dependencies & scripts
├── tailwind.config.js               # Tailwind CSS configuration
├── tsconfig.json                    # TypeScript configuration
└── next.config.ts                   # Next.js configuration
```

---

## 🚀 Getting Started

### Prerequisites

| Tool | Version | Installation |
|---|---|---|
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org) |
| **Rust** | Latest stable | [rustup.rs](https://rustup.rs) |
| **wasm32 target** | — | `rustup target add wasm32-unknown-unknown` |
| **Stellar CLI** | Latest | [stellar/stellar-cli](https://github.com/stellar/stellar-cli) |
| **Freighter Wallet** | Latest | [freighter.app](https://www.freighter.app/) |

### Step 1 — Install Dependencies

```bash
# Frontend dependencies
npm install

# Rust contract dependencies
cd contracts/core-flow && cargo fetch && cd ../..
```

### Step 2 — Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your values:

```env
# Network: testnet or public
NEXT_PUBLIC_STELLAR_NETWORK=testnet

# Read-only address for simulations (any valid testnet address)
NEXT_PUBLIC_STELLAR_READ_ADDRESS=GBRPYHIL2CI3FZJ...

# Your deployed contract ID (see Deployment section)
NEXT_PUBLIC_STELLAR_CONTRACT_ID=CAU3FQTWCAFJF4X...
```

### Step 3 — Build the Smart Contract

```bash
npm run contract:build
```

### Step 4 — Run the Development Server

```bash
npm run dev
```

Open **[http://localhost:3000/dashboard](http://localhost:3000/dashboard)** in your browser.

---

## 🔄 How It Works

CoreFlow implements a **5-step on-chain workflow** for paying remote workers:

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Step 1    │    │   Step 2    │    │   Step 3    │    │   Step 4    │    │   Step 5    │
│             │───▶│            │───▶│             │───▶│            │───▶│             │
│  Initialize │    │   Submit    │    │  Manager    │    │  Finance    │    │  Finalize   │
│   Escrow    │    │   Hours     │    │  Approval   │    │  Approval   │    │  Payment    │
│             │    │   Proof     │    │             │    │             │    │             │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
    Manager           Worker +           Manager           Finance           Manager
  creates escrow    Oracle signs      approves on-chain  approves on-chain  releases USDC
  with schedules    hours data        via Freighter      via Freighter      to worker
```

### Detailed Flow

| Step | Actor | Action | Contract Function |
|---|---|---|---|
| **1. Initialize** | Manager | Creates escrow with worker addresses, amounts, and payment schedules | `initialize_multi_sig_escrow()` |
| **2. Hours Proof** | Worker | Submits oracle-signed hours data (Ed25519 signature verification) | `submit_hours_proof()` |
| **3. Manager Approve** | Manager | Reviews hours and approves payment via Freighter wallet | `manager_approve()` |
| **4. Finance Approve** | Finance | Reviews budget and approves payment via Freighter wallet | `finance_approve()` |
| **5. Finalize** | Manager | Both approvals confirmed → USDC released to worker | `finalize_payment()` |

> **Simulate before Submit:** Every write transaction is first simulated using a read-only address (`NEXT_PUBLIC_STELLAR_READ_ADDRESS`) to preview gas costs and catch errors — without mutating chain state.

---

## 📜 Smart Contract (Soroban)

### Architecture

The `CoreFlowContract` is a Rust-based Soroban smart contract implementing:

- **Multi-signature escrow** — Dual approval (Manager + Finance) before payment release
- **Payment schedules** — `Vec<PaymentSchedule>` supporting multiple workers and recurring payments
- **Oracle integration** — Ed25519 signature validation for external time-tracking data
- **State management** — Persistent on-chain storage of all escrow and payment state

### Contract Functions

```rust
// Create a new multi-sig escrow with payment schedules
initialize_multi_sig_escrow(
    manager: Address,
    finance_approver: Address,
    payments: Vec<PaymentSchedule>,
) -> Result<u32, u32>

// Submit oracle-signed hours proof for a payment
submit_hours_proof(
    escrow_id: u32,
    payment_id: u32,
    hours_logged: i128,
    signature: Bytes,              // Ed25519 signature (≥64 bytes)
) -> Result<(), u32>

// Manager approves the escrow (requires manager auth)
manager_approve(escrow_id: u32) -> Result<(), u32>

// Finance approves the escrow (requires finance_approver auth)
finance_approve(escrow_id: u32) -> Result<(), u32>

// Release payment after both approvals (requires manager auth)
finalize_payment(escrow_id: u32) -> Result<Vec<PaymentSchedule>, u32>

// Read escrow details (no auth required)
get_escrow(escrow_id: u32) -> Result<CoreFlowEscrow, u32>
```

### Error Codes

| Code | Name | Description |
|---|---|---|
| `1` | `AlreadyApproved` | This party has already approved the escrow |
| `2` | `Unauthorized` | Caller is not authorized for this action |
| `3` | `InvalidOracleSignature` | Oracle signature is invalid or too short |
| `4` | `InvalidPaymentId` | Payment or escrow ID does not exist |
| `5` | `InsufficientApprovals` | Both approvals are required before finalization |
| `6` | `PaymentAlreadyFinalized` | This payment has already been released |
| `7` | `InvalidAmount` | Amount is invalid (e.g., empty payment schedules) |

### Running Tests

```bash
npm run contract:test
```

**Test coverage:**

- ✅ Full happy path: Initialize → Hours Proof → Manager Approve → Finance Approve → Finalize
- ✅ Invalid oracle signature rejection (signature < 64 bytes)
- ✅ Finalization fails without both approvals (`InsufficientApprovals`)
- ✅ Double approval prevention (`AlreadyApproved`)

---

## 🖥️ Frontend (Next.js 14)

### Configuration Module

The [`src/lib/config.ts`](src/lib/config.ts) module provides:

| Capability | Details |
|---|---|
| **Network config** | Testnet / Mainnet toggle via environment variable |
| **RPC endpoints** | Auto-selected based on network (`soroban-testnet.stellar.org`) |
| **Freighter helpers** | `connect()`, `signTransaction()`, `signMessage()`, `isConnected()` |
| **Read address** | `NEXT_PUBLIC_STELLAR_READ_ADDRESS` for gas-free simulations |

### CoreFlowClient

The [`src/lib/contracts.ts`](src/lib/contracts.ts) implements the **Simulate → Submit** pattern:

```typescript
const client = new CoreFlowClient();

// 1. Simulate (read-only, no wallet signing needed)
const sim = await client.simulateManagerApprove(escrowId);

// 2. Submit (Freighter signs + broadcasts to network)
const result = await client.submitManagerApprove(escrowId);
console.log(result.transactionHash); // On-chain tx hash
```

**Available methods:**

| Method | Type | Description |
|---|---|---|
| `simulateManagerApprove()` | Read | Preview manager approval (gas estimate) |
| `simulateFinanceApprove()` | Read | Preview finance approval (gas estimate) |
| `submitManagerApprove()` | Write | Sign & submit manager approval via Freighter |
| `submitFinanceApprove()` | Write | Sign & submit finance approval via Freighter |
| `getEscrow()` | Read | Fetch escrow details from chain |

### Dashboard UI

The [`src/app/dashboard/page.tsx`](src/app/dashboard/page.tsx) provides:

- **Wallet Connection** — Connect/disconnect Freighter with address display
- **Stats Grid** — Total escrows, pending review, ready to release, released
- **Escrow Cards** — Per-escrow detail cards with approval progress timeline
- **Action Buttons** — Manager Approve, Finance Approve, and Finalize Payment
- **Transaction Feed** — Real-time activity log with transaction hashes
- **Error Handling** — User-friendly alerts for failed transactions

---

## 🌐 Deployment to Stellar Testnet

### Step 1 — Fund Your Testnet Account

1. Open [Stellar Friendbot](https://friendbot.stellar.org)
2. Enter your Freighter wallet public key
3. Verify funding at [Stellar Expert](https://stellar.expert/explorer/testnet)

### Step 2 — Generate a Stellar CLI Identity

```bash
stellar keys generate --name coreflow
```

### Step 3 — Build & Deploy

**Linux / macOS:**
```bash
bash deploy.sh
```

**Windows (PowerShell):**
```powershell
.\deploy.ps1
```

**Manual deployment:**
```bash
# Build the contract
npm run contract:build

# Deploy to testnet
stellar contract deploy \
  --network testnet \
  --source coreflow \
  --wasm ./contracts/core-flow/target/wasm32-unknown-unknown/release/core_flow.wasm
```

### Step 4 — Update Configuration

Copy the contract ID from the deployment output and update `.env.local`:

```env
NEXT_PUBLIC_STELLAR_CONTRACT_ID=<your-deployed-contract-id>
```

### Step 5 — Launch

```bash
npm run dev
```

Navigate to **[http://localhost:3000/dashboard](http://localhost:3000/dashboard)** and connect your Freighter wallet.

---

## 🔑 Environment Variables

| Variable | Description | Required |
|---|---|---|
| `NEXT_PUBLIC_STELLAR_NETWORK` | Network to use (`testnet` or `public`) | ✅ |
| `NEXT_PUBLIC_STELLAR_READ_ADDRESS` | Read-only address for simulations (no signing authority needed) | ✅ |
| `NEXT_PUBLIC_STELLAR_CONTRACT_ID` | Deployed CoreFlow contract address | ✅ |
| `NEXT_PUBLIC_FREIGHTER_TIMEOUT` | Wallet connection timeout in ms (default: `5000`) | ❌ |

> All `NEXT_PUBLIC_*` variables are safe to expose client-side per Next.js conventions.

---

## 💻 Development

### Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js development server |
| `npm run build` | Build production bundle |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run contract:build` | Build Soroban smart contract (Rust → WASM) |
| `npm run contract:test` | Run smart contract unit tests |

### Quick Start

```bash
npm install              # Install frontend dependencies
npm run contract:build   # Build the smart contract
npm run contract:test    # Verify tests pass
npm run dev              # Start dev server at localhost:3000
```

---

## 🏗️ Architecture Decisions

### 1. Multi-Signature Escrow

The contract requires **both** `manager` and `finance_approver` to approve before payment can be finalized — ensuring proper governance and separation of duties. Neither party can unilaterally release funds.

### 2. Simulate → Submit Pattern

Following the [Stellar Freighter Integration Guide](https://github.com/armlynobinguar/Stellar-Bootcamp-2026/blob/main/STELLAR_FREIGHTER_INTEGRATION_GUIDE.md), all write operations are first **simulated** using `NEXT_PUBLIC_STELLAR_READ_ADDRESS`:

- ✅ Does NOT mutate contract state
- ✅ Does NOT require signing authority
- ✅ Previews transaction results and gas costs
- ✅ Catches errors before the user signs

### 3. Payment Schedules

`Vec<PaymentSchedule>` enables flexible payment structures:

- Multiple payments to the same worker
- Recurring payment patterns (weekly, monthly)
- Batch processing for team payrolls

### 4. Oracle Integration Pattern

`submit_hours_proof()` demonstrates how to integrate external data sources:

- Ed25519 signature validation ensures data integrity
- Time-tracking systems (oracles) sign the hours data off-chain
- The contract verifies the signature before accepting the proof

---

## 🎨 Design System

CoreFlow implements a **premium dark-mode Web3 dashboard** aesthetic with:

- **Glassmorphism** — `backdrop-blur-lg` + semi-transparent gradient surfaces
- **Color-coded status** — Emerald (success), Amber (pending), Blue (action), Red (error)
- **Gradient text** — Eye-catching metric numbers with directional color gradients
- **Hover elevation** — Cards lift on hover with enhanced shadows and border glow
- **Outfit font** — Modern geometric sans-serif (weights: 400, 500, 600, 700)
- **WCAG AA+ accessibility** — All text/background combinations exceed 8:1 contrast

| Text | Background | Contrast | Grade |
|---|---|---|---|
| `slate-100` | `slate-950` | 15.2:1 | AAA ✅ |
| `slate-300` | `slate-900` | 8.1:1 | AA ✅ |
| `emerald-400` | `slate-950` | 9.3:1 | AAA ✅ |
| `amber-400` | `slate-950` | 10.5:1 | AAA ✅ |

📖 **Full documentation:**
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — Complete color palette, typography, depth system, component patterns
- [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) — Before/after code examples for every component

---

## 🔒 Security Considerations

| Area | Guidance |
|---|---|
| **Private Keys** | Never commit `.env.local` or private keys — use `.gitignore` |
| **Freighter** | Always review transaction details in the Freighter popup before signing |
| **Contract Audits** | This is a bootcamp project — conduct a professional security audit before mainnet |
| **Rate Limiting** | Add rate limits to any API endpoints before production deployment |
| **Read Address** | The `NEXT_PUBLIC_STELLAR_READ_ADDRESS` has no signing authority — it's safe to expose |

---

## 🔧 Troubleshooting

<details>
<summary><strong>Contract build fails</strong></summary>

```bash
# Ensure wasm32 target is installed
rustup target add wasm32-unknown-unknown

# Clear cargo cache and rebuild
cd contracts/core-flow
cargo clean
cargo build --target wasm32-unknown-unknown --release
```
</details>

<details>
<summary><strong>Freighter wallet won't connect</strong></summary>

1. Verify Freighter is installed: [freighter.app](https://www.freighter.app/)
2. Switch Freighter to **Testnet** in wallet settings
3. Ensure your account is funded via [Friendbot](https://friendbot.stellar.org)
4. Refresh the browser page and try again
</details>

<details>
<summary><strong>Transaction simulation fails</strong></summary>

- Verify `NEXT_PUBLIC_STELLAR_READ_ADDRESS` is a valid, funded testnet address
- Confirm the network in `.env.local` matches your Freighter wallet network
- Check that the contract is deployed and the contract ID is correct
- Review browser console for detailed error messages
</details>

<details>
<summary><strong>js-stellar-sdk import errors</strong></summary>

```bash
# Install the Stellar SDK
npm install js-stellar-sdk@10

# Restart the dev server
npm run dev
```
</details>

---

## References

### Research Studies
- ACI Worldwide. (2024). *Cross-border payments: The journey to speed, transparency, and lower costs*.
- Convera. (2024). *B2B cross-border payments report: Navigating fraud and compliance*.
- SRM (Strategic Resource Management). (2024). *The hidden costs of cross-border payments and repair fees*.
- The Payments Association. (2024). *The future of cross-border payments: Projected market growth to 2032*.

### Technical Documentation
| Resource | Link |
|---|---|
| Stellar Freighter Integration Guide | [GitHub](https://github.com/armlynobinguar/Stellar-Bootcamp-2026/blob/main/STELLAR_FREIGHTER_INTEGRATION_GUIDE.md) |
| Soroban Documentation | [developers.stellar.org](https://developers.stellar.org/docs/learn/soroban) |
| js-stellar-sdk | [GitHub](https://github.com/nicktomlin/js-stellar-sdk) |
| Next.js Documentation | [nextjs.org/docs](https://nextjs.org/docs) |
| Stellar Bootcamp 2026 | [GitHub](https://github.com/armlynobinguar/Stellar-Bootcamp-2026) |

---

#Video Demo Link

https://github.com/user-attachments/assets/69dc75e8-108a-45c7-b93d-91fbfce375b7

---

<div align="center">

**Built with ❤️ for [Stellar Philippines Bootcamp 2026](https://github.com/armlynobinguar/Stellar-Bootcamp-2026)**

*On-chain transparency for the future of work.*

</div>
