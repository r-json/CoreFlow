## CoreFlow Project Setup

This is a comprehensive Soroban smart contract + Next.js 14 integration for the Stellar Philippines Bootcamp 2026.

### Project Overview

- **Smart Contract**: Soroban Rust contract for on-chain accounts payable workflows
- **Frontend**: Next.js 14 with Freighter wallet integration
- **Architecture**: Multi-signature escrow with payment schedules
- **Reference**: Stellar Freighter Integration Guide patterns

### Scaffolding Progress

- [x] Clarify Project Requirements
- [x] Create monorepo directory structure
- [x] Scaffold Rust smart contract with full implementation
- [x] Scaffold Next.js 14 frontend with App Router
- [x] Implement Stellar configuration (Section 4)
- [x] Implement CoreFlowClient with simulate/submit methods
- [x] Create dashboard UI with shadcn/ui components
- [x] Add environment configuration and Freighter integration
- [x] Create deployment scripts for Stellar Testnet
- [x] Add comprehensive documentation

### Next Steps

1. **Install Dependencies**
   ```bash
   npm install
   cd contracts/core-flow && cargo fetch
   ```

2. **Build Contracts**
   ```bash
   npm run contract:build
   ```

3. **Configure Environment**
   - Copy `.env.example` to `.env.local`
   - Add your Stellar Testnet addresses

4. **Deploy to Testnet**
   ```bash
   npm run deploy:testnet
   ```

5. **Start Development**
   ```bash
   npm run dev
   ```

### Key Files

- **Rust Contract**: `contracts/core-flow/src/lib.rs`
- **Contract Tests**: `contracts/core-flow/src/test.rs`
- **Frontend Config**: `src/lib/config.ts` (Freighter Integration Guide - Section 4)
- **Client Library**: `src/lib/contracts.ts` (CoreFlowClient)
- **Dashboard**: `src/app/dashboard/page.tsx`
- **Deployment**: `deploy.ps1` (Windows) / `deploy.sh` (Unix)

### Architecture Highlights

1. **Smart Contract Features**
   - Multi-output payment schedule support
   - Conditional multi-signature approval (manager + finance)
   - Oracle integration pattern with Ed25519 signatures
   - Robust error handling with custom error enums

2. **Frontend Integration**
   - Freighter wallet connection via `STELLAR_CONFIG.freighter`
   - Read-only simulation address (NEXT_PUBLIC_STELLAR_READ_ADDRESS)
   - Simulate + Submit pattern for transactions
   - Real-time approval status tracking

3. **Environment Setup**
   - Testnet and Mainnet support
   - Configuration module following Guide Section 4
   - RPC endpoint management
   - Wallet timeout configuration

See `README.md` for complete documentation.
