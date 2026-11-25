# Documentation

This repository holds two things, documented separately:

- **CoreFlow Kit**: the developer toolkit for verifying signed off-chain claims in Soroban contracts. This is the current product.
- **The CoreFlow payroll app**: the payroll and B2B escrow application the kit grew out of. It is kept as a reference application and does not use the kit.

## CoreFlow Kit

| Document | What it covers |
|---|---|
| [kit/claim-format.md](kit/claim-format.md) | The signed claim format, v0.1 (wire version 1). Normative. |
| [kit/security-model.md](kit/security-model.md) | What the kit guarantees, what it leaves to you, and how to test an integration. |
| [kit/key-rotation.md](kit/key-rotation.md) | Registering, rotating and revoking issuer keys. |
| [kit/when-not-to-use.md](kit/when-not-to-use.md) | When `require_auth` or another tool fits better. |
| [kit/evidence.md](kit/evidence.md) | What works today, the evidence for it, and the commands to reproduce it. |
| [kit/roadmap.md](kit/roadmap.md) | The proposed v0.2.0-alpha plan: deliverables and acceptance checks. |
| [../apps/workbench](../apps/workbench) | The Workbench browser tool. |
| [../packages/sdk](../packages/sdk), [../packages/attest](../packages/attest), [../packages/test-vectors](../packages/test-vectors) | Package documentation. |
| [../examples/marketplace-hold](../examples/marketplace-hold) | The worked example and its Testnet end-to-end script. |
| [evidence/testnet-archive/kit-e2e](evidence/testnet-archive/kit-e2e/manifest.json) | Archived Horizon responses for the kit's Testnet runs. |

## CoreFlow payroll app (reference application)

These describe the payroll app in `src/`, `prisma/` and `contracts/core-flow`.
They are accurate for that application but are not about CoreFlow Kit.

| Area | Documents |
|---|---|
| Getting started | [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md), [TUTORIAL.md](TUTORIAL.md), [ENVIRONMENTS.md](ENVIRONMENTS.md) |
| Design | [BULK_PAY.md](BULK_PAY.md), [FUNDING.md](FUNDING.md), [PAYMENT_STATE_MACHINE.md](PAYMENT_STATE_MACHINE.md), [MULTI_TENANCY.md](MULTI_TENANCY.md), [RBAC.md](RBAC.md), [RECONCILIATION.md](RECONCILIATION.md), [ORACLE.md](ORACLE.md), [IMPLEMENTATION_MAP.md](IMPLEMENTATION_MAP.md) |
| Operations | [DEPLOYMENT.md](DEPLOYMENT.md), [DEPLOYMENTS.md](DEPLOYMENTS.md), [RUNBOOK.md](RUNBOOK.md), [SECRET_ROTATION.md](SECRET_ROTATION.md), [ORACLE_KEY_TRANSITION.md](ORACLE_KEY_TRANSITION.md), [UPGRADE_AUTHORITY.md](UPGRADE_AUTHORITY.md), [PRODUCTION_DATABASE_REMEDIATION.md](PRODUCTION_DATABASE_REMEDIATION.md) |
| Reviews | [AUDIT_BASELINE.md](AUDIT_BASELINE.md), [SECURITY_AUDIT.md](SECURITY_AUDIT.md) (an internal review, not an independent audit), [BACKLOG.md](BACKLOG.md) |
| Evidence | [evidence/REVIEWER_EVIDENCE.md](evidence/REVIEWER_EVIDENCE.md), [evidence/TESTNET_VALIDATION.md](evidence/TESTNET_VALIDATION.md), [evidence/DEMO_VIDEO_CHECKLIST.md](evidence/DEMO_VIDEO_CHECKLIST.md), and the payroll records in [evidence/testnet-archive](evidence/testnet-archive/manifest.json) |
| Feedback form template | [USER_FEEDBACK_FORM.md](USER_FEEDBACK_FORM.md) and `create-coreflow-feedback-form.gs`: a form definition only. No responses are kept in this repository, and no user research is claimed for either product. |
