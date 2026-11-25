## What and why

<!-- What does this change, and why? Link the issue it closes, if any. -->

## Area

- [ ] `coreflow-attest` (Rust)
- [ ] `@coreflow/sdk`
- [ ] `@coreflow/test-vectors`
- [ ] Workbench (`apps/workbench`)
- [ ] Examples
- [ ] Documentation or CI
- [ ] Payroll reference app

## Checklist

- [ ] Tests cover the change, and at least one fails without it
- [ ] The mutation checks still kill every mutant (`bash scripts/mutation-check.sh` in Rust packages, `npm run mutation` in the SDK)
- [ ] If the claim format changed: `docs/kit/claim-format.md` is updated, vectors are regenerated (`npm run generate` in `packages/test-vectors`), and both languages pass
- [ ] Docs are updated for any user-visible change
- [ ] No secret keys, production issuer keys, personal data or `.env` files

## How it was tested

<!-- Commands you ran and their results. -->
