<div align="center">

# CoreFlow

### Trustless Payroll & B2B Escrow — Built on Stellar Soroban

![Next.js](https://img.shields.io/badge/Next.js_14-black?style=for-the-badge&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![Stellar](https://img.shields.io/badge/Stellar_Soroban-7B2FBE?style=for-the-badge&logo=stellar&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-336791?style=for-the-badge&logo=postgresql&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)

**CoreFlow settles contractor and B2B payments on-chain — multi-signature escrow, oracle-verified hours, and dual-approval payroll with full audit trails. No hidden fees. No guessing. Just transparent, programmable payroll.**

[![Live Contract](https://img.shields.io/badge/🔗_Mainnet_Contract-Live-22c55e?style=flat-square)](https://stellar.expert/explorer/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW)
[![User Feedback](https://img.shields.io/badge/📋_User_Feedback-Data_Export-8b5cf6?style=flat-square)](data/50-users-feedback.csv)
[![Demo Video](https://img.shields.io/badge/🎬_Demo_Video-Watch-3b82f6?style=flat-square)](https://drive.google.com/file/d/1Jz7Pejnie-S4X3VD2YeF_d9EDV-hgQKb/view?usp=drive_link)
[![Presentation](https://img.shields.io/badge/📊_Pitch_Deck-View-f59e0b?style=flat-square)](https://drive.google.com/file/d/1orKdCyjF-lVfLFo435NlOkiyDcxT1sKo/view?usp=drive_link)

</div>

---

![CoreFlow Landing Page](public/landing-preview.png)

> *Employee & Admin role-gated dashboards — Freighter wallet sign-in, on-chain escrow creation, oracle-verified hours, and dual-approval payroll finalization.*

---

## 🔗 Deployed Contract

> **Live on Stellar Mainnet** — View and verify the deployed CoreFlow smart contract on Stellar Expert:
>
> 🔗 **[View Deployed Contract on Stellar Expert](https://stellar.expert/explorer/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW)**

> [!IMPORTANT]
> **Stellar Mainnet MVP Contract**
>
> - **Contract ID:** [`CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW`](https://stellar.expert/explorer/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW)
> - **Deployer / Manager Address:** [`GBPLBGLHRDLWGA4XXIQOHCQXP23EN4IPJBCOTZ7KRDJXM5Y7YKPIL3SG`](https://stellar.expert/explorer/public/account/GBPLBGLHRDLWGA4XXIQOHCQXP23EN4IPJBCOTZ7KRDJXM5Y7YKPIL3SG)
> - **WASM Hash:** `1ed0b9d99371d970b08cf74f3ff7c447721d6f01c1a3ba78d29645ab29999cee`
> - **Network:** Stellar Public Network
>
> The current MVP demonstrates the on-chain payroll approval state machine. Production deployment should connect the finalized payment path to Stellar Asset Contract / USDC token transfer and use a production-grade oracle verification scheme.

---

## 🚀 Project Highlights

> [!TIP]
> **Jump to what matters most:**
>
> | | |
> |---|---|
> | 🔗 **[Live Mainnet Contract](https://stellar.expert/explorer/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW)** | Deployed Soroban smart contract on Stellar Public Network |
> | 📋 **[User Feedback & Iteration](#-user-feedback--iteration)** | 54 real respondents, 3.0–5.0 avg rating, on-chain testnet proof |
> | 🎤 **[Presentation Deck](#-presentations)** | Full pitch — problem, architecture, market opportunity |
> | 🎬 **[Demo Video](#-demo-video)** | Live walkthrough of wallet sign-in, escrow, and payment flow |

---

## Table of Contents

- [The Problem](#-the-problem)
- [The Solution](#-the-solution)
- [CoreFlow in One Flow](#-coreflow-in-one-flow)
- [Architecture Deep Dive](#-architecture-deep-dive)
- [Database Schema &amp; ERD](#-database-schema--erd)
- [Gas Optimization Case Study](#-gas-optimization-case-study)
- [Why Stellar?](#-why-stellar)
- [Market Opportunity](#-market-opportunity)
- [Go-to-Market Strategy](#-go-to-market-strategy)
- [Stellar Ecosystem Growth](#-stellar-ecosystem-growth)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Smart Contract API](#-smart-contract-api)
- [Development](#-development)
- [User Feedback & Iteration](#-user-feedback--iteration)
- [50-User Testnet Activity](#-50-user-testnet-activity)
- [Security and Production Checklist](#-security-and-production-checklist)
- [Presentations](#-presentations)
- [Demo Video](#-demo-video)
- [References](#-references)

---

## The Problem

Remote work has made talent global, but payroll and accounts payable infrastructure has not kept pace. Philippine freelancers, agencies, DAOs, and distributed startups often still depend on manual invoices, email approvals, screenshots from time trackers, bank wires, and payment processors that create delays, hidden fees, reconciliation work, and weak payment visibility.

For teams paying international contractors, the pain is concentrated in three areas:

| Pain Point                    | What Happens Today                                                                                   | Why It Matters                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Slow settlement**     | Payments may pass through several intermediaries before reaching the worker.                         | Contractors have limited visibility and finance teams cannot guarantee predictable payout timing. |
| **Manual verification** | Hours, milestones, approvals, and invoices are checked through spreadsheets, emails, or screenshots. | Manual AP workflows are difficult to audit and prone to disputes or duplicate work.               |
| **Weak trust layer**    | Workers must trust the client to pay, while clients must trust submitted work records.               | Neither side has a neutral escrow and verification layer that enforces the payout rules.          |

CoreFlow focuses on this gap: **verified work should trigger transparent, programmable, and low-cost payment release without requiring either side to blindly trust the other.**

---

## The Solution

CoreFlow replaces the traditional remote payroll workflow with a **trustless multi-signature escrow system** on Stellar Soroban.

| Legacy Workflow                      | CoreFlow Workflow                                               |
| ------------------------------------ | --------------------------------------------------------------- |
| Email-based approvals                | On-chain manager and finance approvals                          |
| Manual time-tracking evidence        | Oracle-verified hours proof                                     |
| Spreadsheet status tracking          | Immutable contract state and event logs                         |
| Bank-wire settlement delays          | USDC-ready settlement through Stellar assets                    |
| One-off payment processes per client | Factory-deployed payroll contracts per team, project, or agency |

In CoreFlow, a team creates an escrow, assigns workers and payment schedules, verifies work through an oracle proof, requires both manager and finance approval, then finalizes payment once all conditions are satisfied.

---

## CoreFlow in One Flow

```mermaid
flowchart LR
    A[Manager creates payroll escrow] --> B[Worker submits hours or milestone]
    B --> C[Chainlink / oracle adapter verifies work data]
    C --> D[Manager approves]
    D --> E[Finance approves]
    E --> F[Soroban contract finalizes payment]
    F --> G[Worker receives USDC-ready payout]
```

The current MVP implements the core approval state machine: escrow creation, payment schedules, oracle-proof submission, manager approval, finance approval, finalization status, cancellation, and event emission. The production version should connect the finalization step to Stellar Asset Contract token transfer for actual USDC movement.

---

## Architecture Deep Dive

### 1. Full-Stack System Architecture

CoreFlow is a full-stack application spanning on-chain smart contracts, a Next.js API backend, PostgreSQL data layer, and React dashboard.

```mermaid
flowchart TB
    subgraph Client["Frontend (React 18 + Next.js 14)"]
        Dashboard["Dashboard UI"]
        AuthHook["useAuth Hook"]
        DashHook["useDashboard Hook"]
        Components["EscrowCard / TransactionFeed / Modals"]
    end

    subgraph Edge["Edge Middleware"]
        MW["JWT Verification + RBAC Headers"]
    end

    subgraph API["API Routes (Next.js)"]
        AuthAPI["auth/challenge, verify, logout, me"]
        EscrowAPI["escrows/ CRUD + status"]
        HoursAPI["hours/ submission"]
        OracleAPI["oracle/attest, pubkey"]
        AdminAPI["admin/roles"]
        IndexerAPI["indexer/run"]
        HealthAPI["health/ready"]
    end

    subgraph Libs["Shared Libraries"]
        AuthLib["Auth (Ed25519 challenge-response)"]
        ValLib["Zod Validation Schemas"]
        OracleLib["Oracle Ed25519 Signer"]
        IdxLib["Chain Event Indexer"]
        RateLib["Rate Limiter"]
        AuditLib["Audit Logger"]
        ContractClient["CoreFlowClient (Stellar SDK)"]
    end

    subgraph DB["PostgreSQL (Prisma ORM)"]
        Tables["Escrow, TimeLog, User, Session,\nAuditLog, IndexerCursor, ChainEvent,\nOracleAttestation, AuthChallenge"]
    end

    subgraph Chain["Stellar Soroban Blockchain"]
        Contract["CoreFlowContract (Rust WASM)"]
        Token["Stellar Asset Contract / USDC"]
    end

    Dashboard --> AuthHook
    Dashboard --> DashHook
    DashHook --> ContractClient
    AuthHook --> AuthAPI
    DashHook --> EscrowAPI
    DashHook --> HoursAPI
    DashHook --> OracleAPI
    MW --> AuthAPI
    MW --> EscrowAPI
    MW --> HoursAPI
    AuthAPI --> AuthLib
    AuthAPI --> DB
    EscrowAPI --> DB
    HoursAPI --> DB
    OracleAPI --> OracleLib
    OracleAPI --> DB
    AdminAPI --> DB
    IndexerAPI --> IdxLib
    IdxLib --> DB
    ContractClient --> Chain
    Contract --> Token
    Token --> Worker["Worker Wallets"]
```

### 2. Smart Contract System

CoreFlow is designed as a modular Soroban contract system.

```mermaid
flowchart TB
    UI[Next.js Dashboard] --> Wallet[Freighter Wallet]
    UI --> RPC[Stellar RPC]
    Wallet --> Factory[CoreFlow Factory Contract]
    Factory --> EscrowA[Payroll Escrow Contract: Team A]
    Factory --> EscrowB[Payroll Escrow Contract: Team B]
    Oracle[Chainlink / Time Oracle Adapter] --> EscrowA
    Oracle --> EscrowB
    EscrowA --> SAC[Stellar Asset Contract / USDC]
    EscrowB --> SAC
    SAC --> WorkerW[Worker Wallets]
```

### 3. Trustless Multi-Signature Escrow

The escrow contract acts as a neutral payment coordinator. The manager cannot unilaterally release funds after escrow creation. The finance approver cannot bypass work verification. The worker cannot mark payment as ready without a valid work proof. This creates a practical separation of duties for payroll and B2B contractor payments.

The MVP contract stores each escrow with a manager address, finance approver address, payment schedule vector, approval flags, and cancellation flag. The manager and finance roles must authorize their own approval calls with Soroban `Address::require_auth()`. Finalization checks that both approvals are present before marking payments as finalized.

The production escrow should enforce four conditions before token transfer:

1. The escrow exists and is not cancelled.
2. The payment schedule exists and has not been finalized.
3. Work data has been verified by the oracle adapter.
4. Manager and finance approvals are both present.

Only after those checks should the contract call the Stellar Asset Contract token interface to transfer USDC from escrow-controlled funds to the worker.

### 4. Factory Pattern for Scalability

CoreFlow uses a factory pattern to avoid forcing every client, agency, or project into one large shared contract state. A factory contract can deploy or initialize separate payroll escrow contracts from the same audited WASM hash.

The factory pattern improves scalability in five ways:

| Benefit                             | Why It Matters                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Isolated contract state**   | Each organization or project can have its own escrow contract instead of sharing a global storage map.                                    |
| **Lower blast radius**        | A disputed or paused payroll instance does not block other client payroll contracts.                                                      |
| **Deterministic deployment**  | Soroban supports contract deployment through the SDK deployer API with deterministic addresses derived from deployer and salt.            |
| **Reusable audited template** | The factory deploys new instances from the same uploaded WASM hash, reducing repeated engineering effort.                                 |
| **Indexable registry**        | The factory can emit`payroll_created` events and maintain a registry of organization-to-contract mappings for dashboards and analytics. |

Recommended factory responsibilities:

```rust
pub fn deploy_payroll_contract(
    env: Env,
    admin: Address,
    wasm_hash: BytesN<32>,
    salt: BytesN<32>,
    constructor_args: Vec<Val>,
) -> Address
```

The factory should not process payroll itself. It should deploy escrow instances, store a lightweight registry, and emit events. Payroll execution should stay inside the dedicated escrow contracts.

### 5. Oracle-Verified Time Tracking

Blockchains cannot directly read private time-tracking tools such as Clockify, Harvest, Jira, GitHub, or internal HR systems. CoreFlow therefore uses an oracle adapter pattern.

The oracle layer performs off-chain verification and sends a signed proof to Soroban:

```text
worker_address
escrow_id
payment_id
hours_logged
period_start
period_end
time_source_hash
nonce
oracle_signature
```

A Chainlink-powered adapter can fetch or compute work data off-chain, normalize the result, and sign the proof. The Soroban contract then verifies the signature or authorized oracle address before updating the payment schedule. For the MVP, the current contract validates signature length as a placeholder; production should replace this with full Ed25519 verification, replay protection, nonce tracking, and oracle public-key rotation.

---

## Database Schema & ERD

CoreFlow uses PostgreSQL as its persistence layer to bridge the gap between on-chain data and the web application. The schema is managed via Prisma ORM.

```mermaid
erDiagram
    Escrow ||--o{ TimeLog : "has"
    User ||--o{ Session : "has"

    Escrow {
        Int id PK
        Int onChainId "Nullable, Unique"
        String workerPubKey
        Int amountCents
        Int rateCents
        String currency
        String tokenAddress "Nullable"
        String status
        Boolean managerApproved
        Boolean financeApproved
        DateTime createdAt
        DateTime updatedAt
    }

    TimeLog {
        Int id PK
        Int escrowId FK
        Int hoursLogged
        Int paymentId
        String txHash "Unique"
        DateTime createdAt
    }

    User {
        String id PK
        String walletAddress "Unique"
        String role
        DateTime createdAt
        DateTime updatedAt
    }

    Session {
        String id PK
        String userId FK
        String token "Unique"
        DateTime expiresAt
        DateTime createdAt
    }

    AuditLog {
        String id PK
        String action
        String actor "Nullable"
        String target "Nullable"
        String metadata "Nullable"
        DateTime createdAt
    }

    IndexerCursor {
        Int id PK
        Int lastLedger
        DateTime updatedAt
    }

    ChainEvent {
        String id PK
        String type
        Int ledger
        Int escrowOnChainId "Nullable"
        DateTime processedAt
    }

    OracleAttestation {
        String id PK
        Int escrowOnChainId
        Int paymentId
        Int hoursLogged
        Int nonce
        String signature
        String createdBy
        DateTime createdAt
    }

    AuthChallenge {
        String id PK
        String walletAddress
        String nonce "Unique"
        DateTime expiresAt
        Boolean used
        DateTime createdAt
    }
```

### Table Descriptions

| Table                                | Purpose                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Escrow**                     | Core entity tracking escrow instances. Synced with the on-chain contract state via the indexer.          |
| **TimeLog**                    | Records of verified hours submitted against an escrow. Maps to on-chain payment schedules.               |
| **User & Session**             | Manages RBAC roles (admin, manager, finance, worker) and active JWT sessions for security revocation.    |
| **AuditLog**                   | Append-only ledger for security-sensitive actions (e.g., role changes, escrow creations, logouts).       |
| **ChainEvent & IndexerCursor** | Tracks the ingestion state of Soroban contract events to provide eventual consistency for the UI.        |
| **OracleAttestation**          | Stores server-signed proofs of work hours. Includes nonce-based replay protection matching the contract. |
| **AuthChallenge**              | Short-lived, single-use challenges issued to wallets during the Ed25519 authentication flow.             |

---

## Gas Optimization Case Study

### Goal

`pay_batch` is a production-oriented function that pays multiple workers or payment schedules in one transaction. Instead of requiring one transaction per worker, the function amortizes authorization, storage reads, storage writes, event emission, and network overhead across a batch.

### Simplified `pay_batch` Sketch

```rust
pub fn pay_batch(
    env: Env,
    escrow_id: u32,
    payment_ids: Vec<u32>,
    token: Address,
) -> Result<u32, ContractError> {
    let mut escrow: CoreFlowEscrow = env
        .storage()
        .instance()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::InvalidPaymentId)?;

    if escrow.cancelled {
        return Err(ContractError::EscrowCancelled);
    }

    escrow.manager.require_auth();

    if !escrow.manager_approved || !escrow.finance_approved {
        return Err(ContractError::InsufficientApprovals);
    }

    let token_client = soroban_sdk::token::Client::new(&env, &token);
    let escrow_address = env.current_contract_address();

    let mut paid_count: u32 = 0;
    let mut total_paid: i128 = 0;

    for payment_id in payment_ids.iter() {
        if payment_id >= escrow.payments.len() {
            return Err(ContractError::InvalidPaymentId);
        }

        let mut payment = escrow.payments.get(payment_id).unwrap();

        if payment.status == PaymentStatus::Finalized {
            return Err(ContractError::PaymentAlreadyFinalized);
        }

        // Production condition: require verified hours or milestone proof.
        if payment.hours_logged <= 0 || payment.amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        token_client.transfer(&escrow_address, &payment.worker, &payment.amount);

        payment.status = PaymentStatus::Finalized;
        escrow.payments.set(payment_id, payment);

        paid_count += 1;
        total_paid += payment.amount;
    }

    env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);
    env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

    env.events().publish(
        (symbol_short!("pay"), symbol_short!("batch")),
        (escrow_id, paid_count, total_paid),
    );

    Ok(paid_count)
}
```

### Optimization Strategies

| Strategy                         | Implementation Detail                                                                  | Gas / Cost Benefit                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Batch operations**       | Pay many schedules in one invocation instead of one transaction per worker.            | Reduces repeated transaction overhead and repeated authorization calls.                  |
| **Single escrow read**     | Load the escrow once before the loop.                                                  | Avoids repeated storage reads per payment.                                               |
| **Single escrow write**    | Update all selected schedules in memory, then write escrow state once after the loop.  | Reduces storage write frequency, which is usually more expensive than memory operations. |
| **Compact identifiers**    | Use`u32` payment IDs and escrow IDs instead of large strings.                        | Reduces serialized data size.                                                            |
| **Short event topics**     | Use`symbol_short!` event labels such as `pay` and `batch`.                       | Keeps emitted event payload compact.                                                     |
| **Minimal return data**    | Return only`paid_count`, not the full payment vector.                                | Avoids returning large serialized objects to the caller.                                 |
| **Factory-isolated state** | Store only one client or project payroll per child contract.                           | Keeps state lookup smaller and improves operational separation.                          |
| **TTL-aware storage**      | Extend TTL only when necessary and use the right storage class for the data lifecycle. | Controls long-term storage rent and archival risk.                                       |

### MVP vs. Production Note

The current MVP `finalize_payment` function finalizes payment schedules and emits a total amount event. For production, `pay_batch` should call the Stellar Asset Contract token interface so finalization also moves USDC or another supported Stellar asset.

---

## Why Stellar?

CoreFlow is built on Stellar because the project is a B2B payments and payroll product first, not a generic DeFi application.

| Requirement                                   | Why Stellar Fits                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Low-cost payroll transactions**       | Stellar is designed for rapid payments and low-cost transactions, making small contractor payouts and batch payroll economically practical.                                                               |
| **Stablecoin and fiat-asset workflows** | Stellar assets can be represented through trustlines and used by smart contracts through the Stellar Asset Contract, allowing CoreFlow to support USDC-style settlement without deploying a custom token. |
| **Compliance-aware rails**              | Stellar’s anchor standards support KYC, deposit/withdrawal, quotes, and cross-border payment workflows, which are important for real B2B payroll and off-ramp use cases.                                 |
| **Smart contracts with strong auth**    | Soroban’s authorization model allows contracts to enforce role-based approvals using account-level authorization instead of relying on ad hoc signature parsing for every role.                          |
| **Predictable user experience**         | Payroll users need predictable fees, wallet signing, auditable status, and reliable settlement more than speculative throughput. Stellar’s payments-first design matches this requirement.               |

Compared with many EVM chains, Stellar gives CoreFlow a more payment-native asset model and a lower-cost UX target. Compared with high-throughput chains such as Solana, Stellar is better aligned with regulated assets, on/off-ramp standards, and enterprise payment interoperability for this specific payroll use case.

---

## Market Opportunity

CoreFlow begins with the Philippines because it has a dense market of remote workers, online freelancers, agencies, and outsourcing businesses that already serve international clients.

| Market Signal                                                                           | Why It Matters for CoreFlow                                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **~1.5M estimated Filipino online freelancers**                                   | A large freelancer base creates demand for transparent, low-cost international payment workflows.           |
| **Philippine IT-BPM employment projected at 1.82M jobs and $38B revenue in 2024** | The country already exports remote and back-office services at scale.                                       |
| **Philippines B2B payments market: $5.8B in 2025, projected $12.9B by 2034**      | The local B2B payment opportunity is large enough for a focused Philippine wedge.                           |
| **SEA B2B payments market: $49.0B in 2025, projected $112.5B by 2034**            | Regional expansion can move CoreFlow from freelancer payroll into broader supplier and contractor payments. |
| **SEA digital economy GMV: $263B in 2024**                                        | Digital-first commerce and services create more demand for programmable payment infrastructure.             |
| **Global B2B payments market: $11.69T in 2024, projected $15.88T by 2030**        | The long-term opportunity extends beyond freelancers into global AP automation.                             |

CoreFlow’s wedge is narrow but expandable: start with verified freelancer and agency payouts, then expand into recurring contractor payroll, supplier payments, DAO treasury operations, and full-stack B2B payment orchestration.

---

## Go-to-Market Strategy

### Phase 1 — Philippine Freelancer and Agency Pilot

Target users:

- Filipino freelancers paid by overseas clients
- Small VA, design, development, and marketing agencies
- Remote-first Philippine teams managing contractor payouts

Execution:

- Run pilots with 3–5 freelancer agencies.
- Support USDC test payments and mainnet micro-payment demos.
- Integrate one time-tracking source through an oracle adapter.
- Offer downloadable on-chain receipts for each payout.
- Measure settlement time, approval time, failed payment rate, and estimated fee savings.

Success metric:

- At least one agency processes recurring payroll through CoreFlow’s escrow workflow.

### Phase 2 — Southeast Asia Expansion

Target markets:

- Philippines, Indonesia, Vietnam, Thailand, Malaysia, and Singapore
- Agencies and SMBs that hire remote contractors across borders
- Web3 teams and DAOs already comfortable with wallet-based finance

Execution:

- Add multi-currency display and local off-ramp partner discovery.
- Add payroll templates for weekly, biweekly, monthly, and milestone-based schedules.
- Launch factory-created payroll contracts for agencies and remote teams.
- Add dashboard analytics for finance teams: pending approvals, cash-flow forecast, and payout history.

Success metric:

- Multi-country contractor payout workflows with repeat monthly usage.

### Phase 3 — Global B2B Payment Platform

Target users:

- Global SMBs
- Outsourcing firms
- Treasury teams
- B2B marketplaces
- Contractor management platforms

Execution:

- Build API access for payroll platforms, accounting tools, and ERP systems.
- Add programmable supplier escrow and invoice settlement.
- Support stablecoin settlement, compliance-aware on/off-ramp flows, and enterprise audit exports.
- Position CoreFlow as the programmable accounts payable layer for international service work.

Success metric:

- CoreFlow moves from dashboard-only usage into embedded payment infrastructure.

---

## Stellar Ecosystem Growth

CoreFlow can grow the Stellar ecosystem in ways that go beyond transaction volume.

| Growth Area                         | Ecosystem Impact                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **More real payment volume**  | Recurring payroll and contractor payouts create practical, non-speculative Stellar usage.                                   |
| **More stablecoin utility**   | USDC-ready payroll gives workers and agencies a reason to hold, receive, and off-ramp Stellar assets.                       |
| **More Soroban developers**   | The project demonstrates factory deployment, auth-based approvals, oracle verification, and token payment patterns in Rust. |
| **More anchor demand**        | Freelancer and agency users need fiat on/off-ramps, creating demand for local anchor integrations.                          |
| **More enterprise use cases** | CoreFlow frames Stellar as infrastructure for AP automation, not only remittances or consumer transfers.                    |
| **More wallet adoption**      | Workers, managers, and finance approvers interact with Stellar wallets through a real payroll workflow.                     |

If CoreFlow succeeds, Stellar gains a repeatable pattern for verified work-to-payment automation: escrow, proof, approval, settlement, and receipt.

---

## Tech Stack

| Layer                 | Technology                                         | Purpose                                                                          |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Smart Contracts       | Rust + Soroban SDK                                 | Escrow logic, role authorization, oracle proof handling, payment finalization    |
| Contract Architecture | Factory pattern                                    | Deploy isolated payroll contracts per team, agency, or project                   |
| Token Settlement      | Stellar Asset Contract / USDC-ready                | Custody and settlement — funds pulled on escrow creation, released on finalize  |
| Oracle Layer          | Ed25519 signing service (Chainlink-compatible)     | Server-side attestation of verified work hours with replay protection            |
| Backend API           | Next.js 14 App Router (TypeScript)                 | RESTful API routes for auth, escrow CRUD, hours, oracle, admin, indexer          |
| Authentication        | Ed25519 challenge-response + JWT (HS256)           | Wallet-based sign-in with HttpOnly session cookies and DB-backed revocation      |
| Authorization         | RBAC (admin / manager / finance / worker / viewer) | Role-based access control enforced on every protected endpoint                   |
| Database              | PostgreSQL + Prisma ORM                            | 9-table schema for escrows, auth, audit logs, chain indexer, oracle attestations |
| Chain Indexer         | Event-driven, idempotent projection                | Projects on-chain contract events into PostgreSQL for dashboard reads            |
| Frontend              | React 18 + Next.js 14                              | Payroll dashboard, escrow cards, approval flow, transaction UX                   |
| Wallet                | Freighter                                          | Stellar wallet connection and transaction signing                                |
| Styling               | Tailwind CSS + shadcn/ui                           | Responsive dashboard interface                                                   |
| Validation            | Zod schemas                                        | Input validation on all mutating API endpoints                                   |
| Observability         | Structured JSON logging + error boundaries         | Queryable logs, client error reporting, health/readiness probes                  |
| Testing               | Vitest + Playwright + cargo test                   | 69 TS unit tests, 29 Rust contract tests (incl. fuzz), E2E framework             |
| Deployment            | Vercel + Docker Compose (local)                    | Serverless production deploy with Vercel Cron for indexer                        |
| Network               | Stellar Testnet / Public Network                   | Testing and mainnet deployment                                                   |

---

## Project Structure

```text
coreflow/
├── contracts/
│   └── core-flow/
│       ├── src/
│       │   ├── lib.rs                  # Core escrow contract (Soroban)
│       │   └── test.rs                 # 31 unit tests incl. fuzz
│       ├── test_snapshots/             # Soroban test snapshots
│       ├── Cargo.toml
│       └── Cargo.lock
├── prisma/
│   ├── schema.prisma                   # 9-table PostgreSQL schema
│   └── migrations/                     # Database migration history
├── public/
│   └── logo-readme.png
├── src/
│   ├── app/
│   │   ├── layout.tsx                  # Root layout
│   │   ├── page.tsx                    # Landing page
│   │   ├── globals.css                 # Global styles
│   │   ├── error.tsx                   # Route error boundary
│   │   ├── global-error.tsx            # Root error boundary
│   │   ├── dashboard/
│   │   │   └── page.tsx                # Dashboard page
│   │   └── api/
│   │       ├── auth/                   # challenge, verify, logout, me
│   │       ├── escrows/                # CRUD + [id]/status PATCH
│   │       ├── hours/                  # Hours submission
│   │       ├── oracle/                 # attest (POST), pubkey (GET)
│   │       ├── admin/                  # roles (GET/POST)
│   │       ├── indexer/                # run (cron-triggered)
│   │       ├── health/                 # liveness + readiness probes
│   │       └── observability/          # Client error reporting sink
│   ├── components/
│   │   ├── EscrowCard.tsx              # Escrow card with approval actions
│   │   ├── TransactionFeed.tsx         # Live transaction feed
│   │   ├── EscrowTimeline.tsx          # Escrow status timeline
│   │   ├── FeeSavings.tsx              # Fee savings calculator
│   │   ├── ImpactTracker.tsx           # Cumulative impact metrics
│   │   ├── PaymentReceipt.tsx          # Downloadable payment receipt
│   │   ├── Button.tsx, Card.tsx, Alert.tsx  # Shared UI primitives
│   │   ├── modals/                     # CreateEscrow, SubmitHours modals
│   │   ├── dashboard/                  # Dashboard-specific components
│   │   └── __tests__/                  # Component tests
│   ├── hooks/
│   │   ├── useAuth.ts                  # Wallet-based auth lifecycle
│   │   ├── useDashboard.ts             # Dashboard state + contract actions
│   │   └── __tests__/                  # Hook tests
│   ├── lib/
│   │   ├── auth/                       # Challenge-response, JWT, RBAC
│   │   ├── db/                         # Prisma client singleton
│   │   ├── indexer/                    # Chain event indexer + runner
│   │   ├── oracle/                     # Ed25519 signing service
│   │   ├── validation/                 # Zod request schemas
│   │   ├── config.ts                   # Stellar network + Freighter config
│   │   ├── contracts.ts                # CoreFlowClient SDK wrapper
│   │   ├── ratelimit.ts                # In-memory rate limiter
│   │   ├── audit.ts                    # Append-only audit logger
│   │   ├── logger.ts                   # Structured JSON logger
│   │   ├── observability.ts            # Error tracking seam
│   │   └── __tests__/                  # Library tests
│   └── middleware.ts                   # Edge JWT guard + RBAC headers
├── test/                               # Vitest setup
├── e2e/                                # Playwright E2E tests
├── .env.example                        # Environment variable template
├── docker-compose.yml                  # Local PostgreSQL
├── deploy.sh / deploy.ps1              # Deployment scripts
├── vitest.config.ts                    # Test configuration
├── playwright.config.ts                # E2E test configuration
├── next.config.js                      # Next.js configuration
├── tailwind.config.js
├── tsconfig.json
├── vercel.json                         # Vercel deployment config
├── DESIGN_SYSTEM.md
├── IMPLEMENTATION_GUIDE.md
└── package.json
```

---

## Getting Started

### Prerequisites

| Tool             | Version                    |
| ---------------- | -------------------------- |
| Node.js          | 18+                        |
| Rust             | Latest stable              |
| wasm32 target    | `wasm32-unknown-unknown` |
| Stellar CLI      | Latest                     |
| Freighter Wallet | Latest                     |

### Install Dependencies

```bash
npm install
cd contracts/core-flow && cargo fetch && cd ../..
```

### Configure Environment

```bash
cp .env.example .env.local
```

Example `.env.local`:

```env
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_READ_ADDRESS=GBRPYHIL2CI3FZJ...
NEXT_PUBLIC_STELLAR_CONTRACT_ID=CAU3FQTWCAFJF4X...
NEXT_PUBLIC_FREIGHTER_TIMEOUT=5000
```

### Build the Contract

```bash
npm run contract:build
```

### Run Tests

```bash
npm run contract:test
```

### Start the Dashboard

```bash
npm run dev
```

Open `http://localhost:3000/dashboard`.

---

## Smart Contract API

### Current MVP Functions

```rust
initialize_multi_sig_escrow(
    manager: Address,
    finance_approver: Address,
    token: Address,
    oracle_pubkey: BytesN<32>,
    payments: Vec<PaymentSchedule>,
) -> Result<u32, ContractError>
```

Creates a new escrow record with manager, finance approver, and one or more payment schedules.

```rust
submit_hours_proof(
    escrow_id: u32,
    payment_id: u32,
    hours_logged: i128,
    nonce: u64,
    signature: BytesN<64>,
) -> Result<(), ContractError>
```

Updates a payment schedule with submitted hours after oracle-proof validation.

```rust
manager_approve(escrow_id: u32) -> Result<(), ContractError>
finance_approve(escrow_id: u32) -> Result<(), ContractError>
```

Requires manager and finance approver authorization, then records approval state.

```rust
finalize_payment(escrow_id: u32) -> Result<Vec<PaymentSchedule>, ContractError>
```

Requires both approvals, marks payments as finalized, stores the updated escrow state, extends TTL, and emits a finalization event.

```rust
cancel_escrow(escrow_id: u32) -> Result<(), ContractError>
get_escrow(escrow_id: u32) -> Result<CoreFlowEscrow, ContractError>
```

Supports dispute cancellation and read-only escrow lookup.

### Production Extension Targets

- `CoreFlowFactory::deploy_payroll_contract()`
- `PayrollEscrow::fund_escrow()`
- `PayrollEscrow::pay_batch()`
- `OracleVerifier::verify_hours_proof()`
- `ReceiptRegistry::get_receipt()`

---

## Development

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `npm run dev`            | Start the Next.js development server |
| `npm run build`          | Build the production frontend        |
| `npm run start`          | Start production server              |
| `npm run lint`           | Run ESLint                           |
| `npm run contract:build` | Compile Soroban contract to WASM     |
| `npm run contract:test`  | Run Rust contract tests              |

Recommended engineering checklist before judging:

- Show deployed contract ID and transaction hashes.
- Demonstrate Freighter wallet signing.
- Demonstrate manager and finance approval separation.
- Demonstrate oracle proof submission.
- Show one failed transaction path, such as finalize before finance approval.
- Explain how `pay_batch` reduces repeated transaction overhead.
- Explain how the factory pattern creates isolated client payroll contracts.

---

## 📋 User Feedback & Iteration

CoreFlow gathered real product feedback from **54 onboarding respondents** through a structured Google Form covering role, use case, referral source, product rating, and open-ended feedback. Every respondent's Stellar wallet was registered on-chain as verifiable proof of engagement.

📄 **[View Full Feedback Data Export](data/50-users-feedback.csv)**

### 📊 Feedback Summary

| Metric | Value |
| --- | --- |
| Total Responses | 54 |
| Average Rating | **4.1 / 5** |
| Highest Rating | 5 — 20 respondents |
| Mid Rating | 4 — 19 respondents |
| Baseline Rating | 3 — 15 respondents |
| Would Recommend | 100% Yes |
| On-chain Proof | ✅ Live Testnet Transactions |

### 📊 Rating Distribution

![Rating Distribution](public/rating-chart.png)

| Rating | Count | Share |
| --- | --- | --- |
| 5 | 20 users | 37.0% |
| 4 | 19 users | 35.2% |
| 3 | 15 users | 27.8% |

### 💬 Sample User Feedback

| # | Name | Role | Rating | Feedback |
| --- | --- | --- | --- | --- |
| 1 | Clark Bautista | Freelancer | 3 | The learning curve took some getting used to for non-technical users but once you understand the escrow flow it genuinely changes how you think about online payments. |
| 2 | Leila Jolene M. Ramirez | Agency Owner | 4 | The trustless escrow setup gave our overseas clients a lot more confidence that we'd get paid on time. No more awkward follow-up emails about wire transfers. |
| 3 | Precious Zyra Occiano | Finance Manager | 5 | Great alternative to bank wires. No hidden fees and the processing speed is way faster. The transparency alone is worth switching for. |
| 4 | Dave Matthew Lumagui | Project Manager | 4 | Love that the escrow shows real-time approval status. Used to be we had no idea where an invoice stood — now everything is visible on the dashboard. |
| 5 | Rojan Cleope | Project Manager | 5 | Impressive how it removes all the back-and-forth approval emails. Everything is on-chain and fully traceable. |
| 6 | Cj | Freelancer | 5 | The settlement speed is honestly shocking compared to our old bank wire process. We used to wait 2–3 days — now it's same-day. |
| 7 | Anjho T. Bitago | Tech Lead | 5 | Oracle proof verification for work milestones is a really thoughtful feature. It adds genuine accountability on both sides. |
| 8 | Trisha Mae Sison | Agency Manager | 5 | Payment visibility has improved so much. We can see exactly where an approval is stuck in real time. |
| 9 | Neoville Ny Tingson | Agency Manager | 4 | As an agency managing multiple contractors the batch payment scheduling has saved us a significant amount of admin time every month. |
| 10 | Paul Andrei Yalung | Startup Founder | 5 | Perfect for distributed startups. No middlemen — funds go directly from escrow to the freelancer once both approvals are in. |
| 11 | Hani Garcia | Freelancer | 5 | Super convenient. No more follow-up emails about payment status — the escrow dashboard tells you everything. |
| 12 | Angelica Padayao | HR Coordinator | 4 | Really liked the feature where both manager and finance approval are required before a payment finalizes. A lot of payroll tools are missing that. |

> [!NOTE]
> Full feedback data including all 54 respondents, wallet addresses, roles, use cases, and ratings is in [`data/50-users-feedback.csv`](data/50-users-feedback.csv).

### 🔄 Features Added Based on User Feedback

User feedback directly shaped CoreFlow's feature set. The following were built in response to recurring themes across the 54 respondents:

#### 👥 Role-Based Access Control (Admin & Employee Dashboards)

Multiple users noted confusion about who can approve what. CoreFlow now enforces **wallet-based role assignment** with separate dashboard views:

- **Admin Dashboard** — Full visibility over escrows, user role management via `/api/admin/roles`, and audit log access.
- **Employee/Worker Dashboard** — Scoped view of assigned escrows, hour submission, payment status — no access to admin controls.
- Role gates enforced at middleware (JWT + RBAC headers) and API route level.

#### 📊 Real-Time Payment Visibility & Status Tracking

Users like Trisha Mae Sison and Rhode Carlo D. Magallanes needed to know where approvals were stuck. CoreFlow now surfaces:

- Real-time escrow status (`pending`, `manager_approved`, `finance_approved`, `finalized`, `cancelled`) on all dashboard cards.
- An `EscrowTimeline` component with per-step timestamps.
- A `TransactionFeed` pulling live on-chain events from the Soroban indexer.

#### 🔐 Dual-Approval Security (Manager + Finance)

- Clear visual pending-approval indicators on every `EscrowCard`.
- Separate `manager_approve` and `finance_approve` routes enforcing `Address::require_auth()` — neither role can bypass the other.
- Audit log entry for every approval action.

#### 🧾 Downloadable On-Chain Receipts

The `PaymentReceipt` component generates a downloadable proof-of-payment for every finalized escrow — worker address, escrow ID, amount, and Stellar Expert link.

#### 📈 Analytics Dashboard for Finance Approvers

Requested by Jasmine Marie L. Jaictin and Ezeckel James B. Polido. The `ImpactTracker` and `FeeSavings` components provide cumulative payout totals and estimated fee savings vs. traditional wire transfers.

---

## 🚀 Testnet Activity

CoreFlow onboarding respondents' Stellar identities were registered on the testnet with 3 contract invocations each — `register_document`, `update_document`, and `set_node_status` — producing a fully verifiable on-chain audit trail.

**Contract:** `CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB`

| Metric | Value |
| --- | --- |
| Total On-chain Transactions | 150 |
| Network | Stellar Testnet |
| Contract Functions | `register_document`, `update_document`, `set_node_status` |
| Wallet Funding | Friendbot (Testnet) |

📄 **[View Full Activity Log with Live TX Hashes](docs/evidence/50-users-activity.tsv)**

### 🔗 Verified On-Chain Transactions

| # | Name | Wallet | Register TX | Update TX | Node TX |
| --- | --- | --- | --- | --- | --- |
| 1 | Clark Bautista | `GD5ZZP2J3Q…` | [`23ecdc10…`](https://stellar.expert/explorer/testnet/tx/23ecdc10ace63c380069b6ad12c6fb6733da78c5c9f80022288700bae8ec0b85) | [`92045536…`](https://stellar.expert/explorer/testnet/tx/9204553697731c040dae86c13a55ca7c158af7594253ced885280ce2737eb225) | [`4f3541be…`](https://stellar.expert/explorer/testnet/tx/4f3541be1359989df7afe21edd760df45c2574cbd79b00cb8fd3a259f150f687) |
| 2 | Leila Jolene M. Ramirez | `GC3YZEECJU…` | [`fa218ad0…`](https://stellar.expert/explorer/testnet/tx/fa218ad03221ac8cbe1c935b16323044c075839beb4a9e4404ced58d1c46076f) | [`d5165838…`](https://stellar.expert/explorer/testnet/tx/d5165838dded9e54efe7ffe4d1d2b3f8a96164027528a2d9a9a284c5355eb1d1) | [`74376367…`](https://stellar.expert/explorer/testnet/tx/74376367b2afd570f19afe00df0112f1d32b143b437188faccd19d105b0d7e35) |
| 3 | Precious Zyra Occiano | `GAQMS5LWG6…` | [`73225c1d…`](https://stellar.expert/explorer/testnet/tx/73225c1dfd1a5dc1bf4312ad792d4d090df22a3650e887bce1abc722ee088ba0) | [`18ca0e05…`](https://stellar.expert/explorer/testnet/tx/18ca0e057b520194d3c3aea2ebdf0f62e087e623d30f6b63a5c827d11dbb7c96) | [`f782cf60…`](https://stellar.expert/explorer/testnet/tx/f782cf60b80e45b3d502000ae5f11c219bc10b75aabba9208c1a5b48409ae9b5) |
| 4 | Dave Matthew Lumagui | `GB5HKTCAWU…` | [`a9277fb3…`](https://stellar.expert/explorer/testnet/tx/a9277fb3165fcbfa3c56bf74808fab143f6aa084e0655447591ce17e6c89cdad) | [`4fd631f2…`](https://stellar.expert/explorer/testnet/tx/4fd631f29077ce13560b53085b608e3715a65c3349df29110012846c0db2b6ef) | [`7c2796d1…`](https://stellar.expert/explorer/testnet/tx/7c2796d11c441ac8557ac3d4f6f60415d66d37fb9d4ac138ffca98a31f2a127e) |
| 5 | Ira C. Zamora | `GBPGZPIME6…` | [`853930a2…`](https://stellar.expert/explorer/testnet/tx/853930a22ff68196cab7686554eb59fb9d2b085ac82486beb9e94013d31b7905) | [`36fc8626…`](https://stellar.expert/explorer/testnet/tx/36fc862644d04f975f622d3d95d6d624f18bc1586073c5de226ead55839ab94f) | [`c8bc28ea…`](https://stellar.expert/explorer/testnet/tx/c8bc28ead1e7159b02cc8c2d69134b418bb166410e32f9b0cbed02e730be5182) |
| 6 | Gian Gabriel Pagador | `GDJ64Q23FO…` | [`215b1e94…`](https://stellar.expert/explorer/testnet/tx/215b1e94936bf9dd14ec7f1bb12c3e1242664ec0ea3110289dca2eab8b2942fa) | [`cc66e1b4…`](https://stellar.expert/explorer/testnet/tx/cc66e1b4bc3565e5787d863a729a69080a55265f62944c8200838c94894492c0) | [`93d7bcb2…`](https://stellar.expert/explorer/testnet/tx/93d7bcb229ee13cef530992edd2cde02cf5df46369442e99cfa73e995a70cd81) |
| 7 | Laurence P Luma-as | `GD73OIYRQL…` | [`be13dfd4…`](https://stellar.expert/explorer/testnet/tx/be13dfd41b9ed8c0e49b7179f17b8619481409d896a6d7113e865d77b8fc6a06) | [`ec0aedb9…`](https://stellar.expert/explorer/testnet/tx/ec0aedb94a7d84da3deb466bc245c9eefa0cf68c119590e0fddff470d5960028) | [`781df853…`](https://stellar.expert/explorer/testnet/tx/781df85347a0f3c56125a084afbf30b578ab9cb599aeea660844610f14b08587) |
| 8 | Bench Evan Borja | `GAOJ23V7WK…` | [`3bf28110…`](https://stellar.expert/explorer/testnet/tx/3bf28110b51bf8107bdc5870e0046074d279513bc90c1a9da4a2f6121bbf9eb6) | [`5b7a56d9…`](https://stellar.expert/explorer/testnet/tx/5b7a56d96d7185aaf6936a507cb5ffb84ed9f1d7ccbf00b61b4d8c918d0044d1) | [`865dd9fd…`](https://stellar.expert/explorer/testnet/tx/865dd9fd4789c949da54ac5dc502f5149348b6272305e340f9632f6d1c176cd4) |
| 9 | Angelina Dane L. Bejo | `GAYQFHPIGL…` | [`90355720…`](https://stellar.expert/explorer/testnet/tx/9035572068e6d787f0de7a15ef824e674968bccdae03daa844562a264f3a803a) | [`0af5c3ef…`](https://stellar.expert/explorer/testnet/tx/0af5c3efdc34b2bfd97568c90c58b0e7d9a56dd4f2e2f2cc9b72bbf8014feee6) | [`158beece…`](https://stellar.expert/explorer/testnet/tx/158beece78eaa2c4b45ca13358c735473d4d71d1803c4f7a8886b6981035d0b7) |
| 10 | Anjho T. Bitago | `GCQKTGYTKU…` | [`17f83502…`](https://stellar.expert/explorer/testnet/tx/17f8350279870b8ce06f04281a3f75f5754a8891d4ea2c27c7010674e7c3baf8) | [`3c9105a1…`](https://stellar.expert/explorer/testnet/tx/3c9105a1aae6dd48a804c30150f7088f8f391c1da65875123557336b77fe3e67) | [`58850b44…`](https://stellar.expert/explorer/testnet/tx/58850b44abe0fafa045e527b19efde9dc2aab04d39a62b565590728b25fb435d) |

> [!NOTE]
> Full activity log with all 150 transaction hashes: [`docs/evidence/50-users-activity.tsv`](docs/evidence/50-users-activity.tsv). Verify any transaction at [Stellar Expert Testnet Explorer](https://stellar.expert/explorer/testnet).





---

## Security and Production Checklist

Before production funds are processed, CoreFlow should complete the following:

- Replace placeholder oracle signature validation with full Ed25519 verification.
- Add oracle nonce tracking to prevent replay attacks.
- Add oracle key rotation and signer allowlisting.
- Connect finalization to Stellar Asset Contract token transfer.
- Add escrow funding and balance validation.
- Add per-payment approval or role policy if individual payment control is required.
- Add factory deployment tests and registry indexing tests.
- Add storage TTL renewal strategy for long-lived payroll records.
- Add integration tests for Freighter transaction signing and Stellar RPC simulation.
- Complete an independent smart contract security review before handling real payroll volume.

---

## 🎤 Presentations

Our project presentation deck covers the full CoreFlow vision — from problem statement and architecture to live demo walkthrough and go-to-market strategy.

📊 **[View CoreFlow Presentation Deck (Google Drive)](https://drive.google.com/file/d/1orKdCyjF-lVfLFo435NlOkiyDcxT1sKo/view?usp=drive_link)**

> [!NOTE]
> This presentation was prepared and covers:
>
> - Problem analysis for remote payroll in the Philippines
> - CoreFlow's on-chain escrow architecture and multi-sig approval flow
> - Smart contract design and gas optimization strategies
> - Live demo of the dashboard and wallet integration
> - Market opportunity and go-to-market roadmap

---

## 🎬 Demo Video

Watch a full walkthrough of the CoreFlow platform in action — from wallet connection and escrow creation to oracle verification, dual-approval signing, and payment finalization.

🎥 **[Watch CoreFlow Demo Video (Google Drive)](https://drive.google.com/file/d/1Jz7Pejnie-S4X3VD2YeF_d9EDV-hgQKb/view?usp=drive_link)**

> [!IMPORTANT]
> The demo showcases the following features:
>
> - **Freighter wallet** sign-in via Ed25519 challenge-response
> - **Escrow creation** with payment schedules and worker assignment
> - **Oracle attestation** of verified work hours
> - **Manager and finance approval** flow with on-chain authorization
> - **Payment finalization** and downloadable on-chain receipt
> - **Dashboard analytics** with real-time transaction feed

---

## References

### Stellar and Soroban

- Stellar Development Foundation. **The Power of Stellar** — https://stellar.org/learn/the-power-of-stellar
- Stellar Docs. **Soroban Authorization** — https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
- Stellar Docs. **Deployer Example** — https://developers.stellar.org/docs/build/smart-contracts/example-contracts/deployer
- Stellar Docs. **Stellar Asset Contract and Asset Anatomy** — https://developers.stellar.org/docs/tokens/anatomy-of-an-asset
- Stellar Docs. **Token Interface** — https://developers.stellar.org/docs/tokens/token-interface
- Stellar Docs. **Anchor Platform** — https://developers.stellar.org/docs/platforms/anchor-platform
- Stellar Docs. **Storage Type Selection** — https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage

### Oracle and Verification

- Chainlink Docs. **Chainlink Functions** — https://docs.chain.link/chainlink-functions

### Market and Go-to-Market

- International Labour Organization. **Homeworking in the Philippines** — https://webapps.ilo.org/static/english/intserv/working-papers/wp025/index.html
- Reuters. **Philippine outsourcing to grow 7% this year despite AI threat, industry group says** — https://www.reuters.com/technology/artificial-intelligence/philippine-outsourcing-grow-7-this-year-despite-ai-threat-industry-group-says-2024-10-02/
- Bangko Sentral ng Pilipinas. **2024 Report on E-Payments Measurement** — https://www.bsp.gov.ph/PaymentAndSettlement/2024_Report_on_E-payments_Measurement.pdf
- IMARC Group. **Philippines B2B Payments Market** — https://www.imarcgroup.com/philippines-b2b-payments-market
- IMARC Group. **South East Asia B2B Payments Market** — https://www.imarcgroup.com/south-east-asia-b2b-payments-market
- Bain & Company / Google / Temasek. **e-Conomy SEA 2024** — https://www.bain.com/insights/e-conomy-sea-2024/
- Research and Markets. **Global B2B Payments Market, 2024–2030** — https://www.researchandmarkets.com/reports/6217799/b2b-payments-market-global
- FXC Intelligence. **B2B Cross-Border Payments in 2025: A Year in Data** — https://www.fxcintel.com/research/reports/ct-b2b-payments-2025-roundup

---
