---
name: contract-change
description: Fixed procedure for any change to the Solidity contracts in contracts/contracts/ (new rule, new field, changed function signature, event or struct). Use before editing any .sol file. Covers test-first, Slither, updating the services and frontend that call the ABI, and recording the decision.
---

# Contract change

Contract edits are the riskiest changes in this repo: they ripple into every service, the frontend and the
demo data. Follow these steps in order and don't skip any.

**Before step 1:** if the change alters behaviour that `docs/decisions.md` or `docs/brief.md` defines, propose it to
the user and get agreement first (decisions are binding; see CLAUDE.md). Never add payment, escrow or
token-transfer logic.

## 1. Write a failing test

- Add the test to `contracts/test/<Contract>.ts`, next to the related `describe` block. Reuse the file's fixture
  (`deploy()`, `deliver()`, …) and the `OK` check constant.
- Run just that file and **watch it fail for the reason you expect**, not because of a typo:
  `cd contracts && npx hardhat test mocha test/<Contract>.ts`
- Every one of the brief's required protections has a test. Never delete or weaken one to make a change pass.

## 2. Edit the Solidity

- Keep the existing patterns: `whenSystemActive` on state-changing functions, role checks through `registry`,
  `require` messages a person can read (the frontend shows them), and events for anything the audit log should show.
- Don't name a struct field `at`, `length`, `map` or anything else on `Array.prototype`. ethers returns
  structs as arrays, so the JavaScript side can't read those fields.
- `viaIR` is on, so "stack too deep" is rare. If you hit it, assign struct fields one by one instead of using a
  long constructor call.
- Run the file's tests again until they pass.

## 3. Run the contract tests and Slither

- `npm run test:contracts`: every contract test passes.
- `npm run slither`: no **new** findings compared with `contracts/slither-baseline.txt`. Fix new findings. If a
  finding is intended, explain why in the step 5 decision row, then accept it with `npm run slither -- --update`.
  (Needs `pipx install slither-analyzer`.)

## 4. Update the services and frontend that use the ABI

The deploy script writes addresses and ABIs to `deployments/<network>.json`, and everything loads them at runtime.
No ABI file is copied by hand, but the code that calls the contract must match the new shape.

- Find every use of what you changed: `grep -rn "<functionOrEvent>" services frontend/src frontend/e2e`.
  - ParticipantRegistry: `services/identity-service`
  - ShipmentCustody: `services/custody-service` (`index.ts`, `quality.ts`)
  - SensorOracle: `services/oracle-service` (`evidence.ts`, `index.ts`)
  - CertificateRegistry: `services/certificate-service` (`sync.ts`, `index.ts`)
  - Frontend: `sendTx("<Contract>", "<method>", …)` calls and the shapes in `frontend/src/lib/types.ts`
- Also check `contracts/scripts/deploy.ts` (constructor arguments), `services/common/src/testing.ts`
  (shared test fixtures such as `OK_CHECK`) and the service tests in `services/*/test/`.
- Typecheck what you touched, e.g. `cd services/<name>-service && ../../node_modules/.bin/tsc -p tsconfig.json`
  and `cd frontend && ../node_modules/.bin/tsc -p tsconfig.json`.
- Done only when `npm run test:all` passes. It deploys to its own isolated chain and never touches the demo.
- The user's running demo needs `npm run deploy`, a service restart and `npm run seed` to pick up the new
  contracts. **That wipes their demo data, so ask before doing it.**

## 5. Add a row to docs/decisions.md

- Use the next number, in a dated section (`## Changed on YYYY-MM-DD: …`), in the existing
  `| # | Question | Decision |` table style.
- Say what changed and why, whether the user confirmed it, and any Slither finding you accepted.
- If it changes how the demo runs, update `docs/demo-script.md` and the README too.
