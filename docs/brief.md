# ColdChainSG — Build Prompt

We are building **ColdChainSG**, a prototype web platform that tracks chilled food shipments through Singapore's cold chain and issues tamper-evident quality certificates at each step.

---

## 1. What this platform is (and is not)

ColdChainSG is a **neutral evidence and dispute-resolution layer**, not a payment system.

- It does **not** move money. No escrow, no bonds, no token transfers, no payment release logic — anywhere, in any contract or service.
- It tracks custody of a shipment as it moves between firms, records tamper-evident sensor evidence at each step, and issues certificates showing whether temperature stayed in range.
- If something goes wrong, the platform shows **where** it went wrong and **who** held the batch at the time, so the firms involved can settle the dispute themselves, off-platform.
- IoT sensor data is **simulated by replaying CSV files** — there is no real hardware.

Do not add payment, escrow, or fund-related features even if they seem like a natural extension. That scope is intentionally out.

---

## 2. Actors and roles

| Role | What they do on the platform |
| --- | --- |
| **Importer** | Creates the container, adds batches, assigns each batch to a buyer |
| **Carrier** (air freight) | Holds custody from supplier to Changi handler |
| **Handler** (Changi cargo handler) | Holds custody at the airport leg |
| **Importer's cold store team** | Receives the container and splits it into per-buyer batches |
| **Delivery truck operator** | Holds custody from importer cold store to buyer |
| **Buyer / Inspector (QA team)** | Receives the batch, reviews flagged certificates, signs resolution notes, acknowledges receipt |
| **Admin** | Approves new participants, registers sensors, can pause the system |
| **Oracle service** (not a human) | Replays sensor CSVs, hashes files, submits per-leg summaries |

The custody chain for one container is: **Supplier → Air carrier → Changi handler → Importer cold store (split happens here) → Delivery truck → Buyer.**

---

## 3. High-level architecture

Use a **lean microservices** split — four small services plus a frontend. Do not add a message queue, API gateway, or container orchestration layer; a course project does not need that complexity. Each service is a plain REST API.

| Service | Responsibility | Talks to |
| --- | --- | --- |
| **Identity Service** | Wallet-based login, participant onboarding/approval, role lookup | ParticipantRegistry contract |
| **Custody Service** | Container/batch creation, handovers, the cold-store split | ShipmentCustody contract |
| **Oracle Service** | Replays CSV files per leg, computes SHA-256 hash and summary stats, submits to chain | SensorOracle contract |
| **Certificate Service** | Listens for leg submissions, issues LegPass records, opens claims, records inspector resolutions, rolls up the final certificate, records buyer acknowledgement | CertificateRegistry contract |

A single React frontend calls these four services directly — no gateway needed.

**Suggested repo layout:**

```
coldchainsg/
  contracts/              # Solidity, Hardhat config and tests
  services/
    identity-service/
    custody-service/
    oracle-service/
    certificate-service/
  frontend/
  data/
    raw/                  # compliant CSV, breached CSV, tampered CSV
    processed/
  docs/
```

**Suggested stack** (common, actively maintained, open source — do not substitute niche or unmaintained libraries):

- **Contracts:** Solidity ^0.8.x, Hardhat, OpenZeppelin Contracts (`AccessControl`, `Pausable`), ethers.js v6
- **Backend services:** Node.js + Express, TypeScript
- **Auth:** wallet-based login — connect MetaMask, sign a one-time message, verify the signature server-side (the standard "Sign-In with Ethereum" pattern). No passwords to store.
- **Database:** one lightweight Postgres instance is fine for a course project; keep each service's tables logically separate even if they share the instance
- **Frontend:** React + Vite, Tailwind CSS, Framer Motion (landing page animation), ethers.js (wallet connect), Recharts (KPI charts)
- **Security hygiene:** `helmet`, `cors` scoped to the frontend origin, `dotenv` for secrets, input validation on every endpoint (e.g. `zod`)

---

## 4. Smart contracts (keep these simple)

Four contracts. No escrow, no payment, no bonds, no reentrancy-sensitive fund transfers — so skip `ReentrancyGuard` unless a later feature needs it.

| Contract | Core data | Key functions |
| --- | --- | --- |
| **ParticipantRegistry** | wallet, role, active status | `registerParticipant`, `suspendParticipant`, `hasRole` (OpenZeppelin `AccessControl`) |
| **ShipmentCustody** | container, batches, route, handover state | `createContainer`, `addBatch`, `initiateTransfer`, `acceptTransfer`, `splitContainer`, `getCustodianAt` |
| **SensorOracle** | sensor ID, per-leg file hash, min/max temp, breach minutes | `registerSensor`, `submitLegSummary`, `verifyFileHash` |
| **CertificateRegistry** | leg passes, claims, resolutions, final certificate, acknowledgement | `issueLegPass`, `openClaim`, `submitResolution`, `issueFinalCertificate`, `acknowledgeReceipt` |

### Data model

| Entity | Fields |
| --- | --- |
| LegPass | shipment_id, batch_id, leg_number, custodian, file_hash, max_temp, breach_minutes, status (`pass` / `flagged`) |
| Claim | claim_id, batch_id, leg_number, breach_start, breach_end, provisional_custodian |
| Resolution | claim_id, inspector, outcome (`upheld` / `overturned` / `compensation_agreed`), note, signed_at |
| FinalCertificate | batch_id, overall_status (`clean` / `flagged`), leg_pass_ids, resolution_ids, issued_at |
| Acknowledgement | batch_id, buyer, acknowledged_at |

### What stays on-chain vs. off-chain

| On-chain | Off-chain |
| --- | --- |
| Participant wallet + role | Participant organisation name, contact details |
| Custody transfer timestamps | High-frequency GPS, operational detail |
| Sensor file SHA-256 hash, leg summary | Raw second-by-second sensor readings (CSV) |
| LegPass status, claim, resolution, certificate | Inspection notes/photos beyond the resolution note itself |

### Required state protections (write tests for each)

| Attempt | Expected result |
| --- | --- |
| Submit from an unregistered oracle or sensor | Reject |
| Submit the same leg/nonce twice | Reject |
| Transfer custody from a wallet that isn't the current custodian | Reject |
| Split the container before it reaches the importer cold store step | Reject |
| Submit a resolution from a wallet that isn't the assigned inspector | Reject |
| Acknowledge receipt from a wallet that isn't the batch's buyer | Reject |
| Use a file whose hash doesn't match what was recorded | Mark evidence mismatch; block LegPass issuance until resubmitted |
| Issue a final certificate before every leg has reported | Reject |

---

## 5. Lifecycle (what actually happens)

1. Admin approves new participants and assigns roles.
2. Importer creates a container (origin, sensor ID, departure date) and adds one or more batches, each assigned to a registered buyer, with a temperature threshold (default 4°C) and grace period (default 15 minutes) — both editable per batch.
3. Custody moves through each leg with a two-step handover: the current custodian initiates, the next custodian accepts.
4. At each leg, the Oracle Service replays that leg's CSV, hashes it, and submits a summary. The Certificate Service turns this into a **LegPass**: pass or flagged.
5. A flagged leg opens a **Claim**, tagged to whoever held custody when the breach started.
6. At the importer cold store, the container **splits into its individual batches**; custody tracking continues per batch from there.
7. After the last leg, the Certificate Service rolls every LegPass into one **FinalCertificate** per batch: clean if every leg passed, flagged if any leg flagged.
8. If flagged, the buyer's QA inspector reviews the evidence and submits a **Resolution** (upheld / overturned / compensation agreed) with a note. This updates the certificate's status — it moves no funds.
9. The **buyer acknowledges receipt**. This closes the batch. Tracking stops here.

---

## 6. Application flows

**Landing page** (public, no login) — animated hero showing a container moving through the six custody stops ending in a certificate checkmark; one paragraph stating the problem (fragmented evidence, slow disputes); a "how it works" section (3–4 steps); an impact/stats section (e.g. average dispute resolution time, % clean certificates — can be demo data, clearly labelled); a "Connect Wallet" call to action.

**Login** — connect MetaMask, sign a message, backend verifies and looks up the role in ParticipantRegistry. Known wallet → straight to that role's dashboard. Unknown wallet → a short "Request Access" form, routed to the admin for approval.

**Onboarding** — admin dashboard lists pending access requests; approving one assigns a role and registers the wallet on-chain.

**Importer flow** — create container → add batches (buyer, product, quantity, threshold/grace period) → submit.

**Carrier / Handler flow** — dashboard of assigned legs; accept an incoming handover; initiate the next one. At the cold-store step, an additional "Split into batches" action.

**Oracle / demo control** — an admin-only panel to trigger a CSV replay for a given leg (compliant file, breached file, or a deliberately tampered file to demonstrate hash mismatch). This is how the demo is driven.

**Buyer / Inspector (QA) flow** — dashboard shows batches awaiting acknowledgement and any open claims; a claim view shows the breach evidence (leg timeline, hash, max temp, breach minutes) and a form to submit the resolution note; an "Acknowledge Receipt" action on delivered batches.

**Admin flow** — participants, sensors, paused state, audit log, and the impact/KPI overview.

---

## 7. UI/UX requirements

- Clean, minimal, highly readable — this is a dispute-evidence tool, so clarity beats decoration.
- Consistent status colour coding: pass = green, flagged/pending review = amber, rejected/breach = red.
- Card-based dashboards, generous white space, one clear primary action per screen.
- Sans-serif type (e.g. Inter), light cold-chain-appropriate palette (cool blues/teals), sparing use of thermometer/snowflake iconography.
- The landing page animation and the impact/KPI numbers should make the project's value obvious within a few seconds — this is a graded demo, so the "why this matters" story needs to land visually, not just in text.
- Fully responsive; every flow above should work cleanly on a laptop screen in a 10-minute live demo.

---

## 8. Instructions to you, the build agent

- Keep every service and contract as simple and readable as possible. Prefer straightforward code over clever abstractions — this is a 1-developer, 8-week course project, not a production system.
- Use well-known, actively maintained open-source libraries for anything security-sensitive (auth, hashing, signatures). Do not hand-roll cryptography.
- Never add payment, escrow, bonding, or token-transfer logic anywhere, even if it would be easy to bolt on.
- Build and test end-to-end in this order: ParticipantRegistry + login → ShipmentCustody + handovers → SensorOracle + CSV replay → CertificateRegistry + the full certificate lifecycle → frontend dashboards → landing page polish. Get one slice fully working before starting the next.
- **If a requirement here is ambiguous, or a design decision isn't specified, stop and ask rather than assuming.**

---

## 9. Out of scope (do not build)

Payment, escrow, bonds, consumer-facing traceability, real IoT hardware, testnets other than Sepolia, machine-learning spoilage prediction, insurance claim automation.
