# ColdChainSG — Build Prompt

> Kept in step with what the app does (last updated 2026-10-17). The original brief is in the git
> history; [decisions.md](decisions.md) records every change from it and why.

We are building **ColdChainSG**, a prototype web platform that tracks chilled food shipments through Singapore's cold chain and issues tamper-evident quality certificates at each step.

---

## 1. What this platform is (and is not)

ColdChainSG is a **neutral evidence and dispute-resolution layer**, not a payment system.

- It does **not** move money. No escrow, no bonds, no token transfers, no payment release logic — anywhere, in any contract or service.
- It tracks custody of a shipment as it moves between firms, records tamper-evident sensor evidence from **each holder's own sensor**, and issues certificates showing whether temperature stayed in range.
- If something goes wrong, the platform shows **where** it went wrong and **who** held the batch at the time, so the firms involved can settle the dispute themselves, off-platform.
- There is no real IoT hardware. Sensors report through a **simulated sensor gateway**: a demo sensor reads compliant or breached, relative to the temperature limits of the batches it covers, or a participant attaches their own sensor's export, which stands in for the live feed.
- Shipments may go **by air or by sea**; nothing is specific to one mode.

Do not add payment, escrow, or fund-related features even if they seem like a natural extension. That scope is intentionally out.

---

## 2. Actors and roles

| Role | What they do on the platform |
| --- | --- |
| **Supplier** | Creates batches (each with its buyer, quality inspector, max temperature and grace period), covers them with its cold-room sensor, and signs each batch off to Cargo |
| **Cargo** (air or sea carrier) | Opens a container and registers its sensor, receives batches straight into it, seals it, and ships it |
| **Destination Freight Handler** | Takes the sealed container at the destination port or airport and hands it to the cold store (the container's sensor keeps reading) |
| **Cold Store** | Receives the container, covers its batches with its cold-room sensor, unloads it, and signs each batch off to a reefer truck |
| **Reefer Truck** | Registers its truck sensor and delivers each batch to its buyer |
| **Buyer** | Signs the delivery in, and acknowledges receipt once QA has decided, which closes the batch |
| **Quality Inspector** (the buyer's QA team) | Rules on each flagged stage, then releases the batch for sale or rejects it |
| **Admin** | Runs the platform only: approves and suspends participants, can pause the system, sees the overview and audit log. Has no part in shipments or sensors |
| **Sensor gateway** (not a human) | Holds each sensor's device key; when a stage closes, the sensor commits the SHA-256 of its readings on-chain |
| **Oracle service** (not a human) | Summarises each stage's committed readings per batch and submits the summaries on-chain |

The custody chain for one batch is: **Supplier → Cargo → Destination Freight Handler → Cold Store (the container is unloaded here) → Reefer Truck → Buyer.**

---

## 3. High-level architecture

Use a **lean microservices** split — five small services plus a frontend. Do not add a message queue, API gateway, or container orchestration layer; a course project does not need that complexity. Each service is a plain REST API.

| Service | Responsibility | Talks to |
| --- | --- | --- |
| **Identity Service** | Wallet-based login, participant onboarding/approval, role lookup, the public directory of names | ParticipantRegistry contract |
| **Custody Service** | Batch and container details, spot readings, issue reports, sealed handover notes, shipment views | ShipmentCustody contract |
| **Sensor Gateway** | Sensor registration (device keys), simulated or attached readings, committing each stage's readings hash | ShipmentCustody, SensorOracle contracts |
| **Oracle Service** | Fetches committed readings, summarises them per batch, submits summaries; serves each batch's evidence | SensorOracle contract |
| **Certificate Service** | Opens claims for flagged stages, issues LegPass records, rolls up the final certificate; claim, KPI and audit views | CertificateRegistry contract |

A single React frontend calls these five services directly — no gateway needed. Participants sign their own on-chain actions in MetaMask.

**Repo layout:**

```
coldchainsg/
  contracts/              # Solidity, Hardhat config and tests
  services/
    common/
    identity-service/
    custody-service/
    sensor-gateway/
    oracle-service/
    certificate-service/
  frontend/
  data/
    raw/                  # sample sensor exports (compliant, breached, reefer excursion)
  docs/
```

**Stack** (common, actively maintained, open source — do not substitute niche or unmaintained libraries):

- **Contracts:** Solidity 0.8.34 (pinned), Hardhat 3, OpenZeppelin Contracts (`AccessControl`, `Pausable`), ethers.js v6
- **Backend services:** Node.js + Express, TypeScript
- **Auth:** wallet-based login — connect MetaMask, sign a one-time message, verify the signature server-side (Sign-In with Ethereum). No passwords to store.
- **Database:** one Postgres instance; each service keeps its tables in its own schema
- **Frontend:** React + Vite, Tailwind CSS, Framer Motion (landing page animation), ethers.js (wallet connect), Recharts (charts)
- **Security hygiene:** `helmet`, `cors` scoped to the frontend origin, `dotenv` for secrets, input validation on every endpoint (`zod`)

---

## 4. Smart contracts (keep these simple)

Four contracts. No escrow, no payment, no bonds, no reentrancy-sensitive fund transfers — so skip `ReentrancyGuard` unless a later feature needs it.

| Contract | Core data | Key functions |
| --- | --- | --- |
| **ParticipantRegistry** | wallet, role, active status | `registerParticipant`, `suspendParticipant`, `roleOf`, `pause` (OpenZeppelin `AccessControl`, `Pausable`) |
| **ShipmentCustody** | batches, containers, handovers with both sides' checks, each stage's sensor, entry and exit times | `createBatch`, `createContainer`, `registerSensor`, `initiateTransfer`, `acceptIntoContainer`, `acceptTransfer`, `recordSeal`, `unloadContainer`, `stageWindow`, `handoverGapMinutes` |
| **SensorOracle** | per-stage readings hash (from the sensor), per-batch stage summary | `commitFileHash`, `submitLegSummary`, `verifyFileHash` |
| **CertificateRegistry** | stage flags, leg passes, claims, resolutions, QA decision, final certificate, acknowledgement | `issueLegPass`, `openClaim`, `submitResolution`, `issueFinalCertificate`, `submitDisposition`, `acknowledgeReceipt` |

### Data model

| Entity | Fields |
| --- | --- |
| Batch | supplier, buyer, inspector, max temperature, grace period, container (once loaded) |
| Container | ISO 6346 number, seal number, Cargo, unloaded at |
| Sensor (per unit and stage) | sensor id, device key, owner |
| Handover check (each side) | probe temperature, damaged, seal intact, issues, notes hash, signer, time (sender: exit; receiver: entry) |
| LegPass (per stage) | batch, stage, custodian, flags, status (`pass` / `flagged`), receipt temperature, handover gap minutes, readings hash, peak, minutes above limit, minutes without readings |
| Claim | batch, stage, breach start/end, provisional custodian |
| Resolution | claim, inspector, outcome (`upheld` / `overturned` / `compensation_agreed`), note, signed at |
| QA decision | disposition (`released` / `rejected`), inspector, note |
| FinalCertificate | batch, status (`clean` / `flagged` / `resolved`), leg pass ids, resolution ids, issued at |
| Acknowledgement | batch, buyer, acknowledged at |

### What stays on-chain vs. off-chain

| On-chain | Off-chain |
| --- | --- |
| Participant wallet + role | Organisation name, contact details |
| Custody, handover checks and their timestamps, seal and container numbers, sensor registrations | Product details, voyage, spot readings, issue reports, notes (their hash is on-chain) |
| Each stage's readings hash, per-batch summary | The sensor readings themselves |
| Flags, LegPass, claim, resolution, QA decision, certificate, acknowledgement | Inspection notes beyond the resolution note itself |

### Required state protections (tested)

| Attempt | Expected result |
| --- | --- |
| Commit readings from anything but the sensor registered for that unit and stage | Reject |
| Submit a summary from an unregistered oracle, or the same stage twice | Reject |
| Transfer custody from a wallet that isn't the current custodian | Reject |
| Sign a stage off before its holder has registered a sensor | Reject |
| Move a batch on its own while it's inside a container | Reject |
| Unload the container before it reaches the cold store | Reject |
| Submit a resolution or decision from a wallet that isn't the assigned inspector | Reject |
| Acknowledge receipt from a wallet that isn't the batch's buyer, or before QA decides | Reject |
| Readings whose hash doesn't match what the sensor committed | Mark evidence mismatch; block LegPass issuance until the genuine readings are submitted |
| Issue a final certificate before every stage has reported | Reject |

---

## 5. Lifecycle (what actually happens)

1. Admin approves new participants and assigns roles.
2. The supplier creates batches, each assigned to a registered buyer and quality inspector, with a max temperature (default 4 °C) and grace period (default 15 minutes), and registers its cold-room sensor for them.
3. Cargo opens a container (number entered, or generated) and registers the container's sensor. The supplier signs each batch off (its exit time) and Cargo signs it in straight into the container (its entry time). Cargo seals the container and signs it off to the destination freight handler, who signs it off to the cold store; each container handover moves every batch inside it.
4. The cold store registers its cold-room sensor for the batches, unloads the container, and signs each batch off to a reefer truck, which registers its own sensor and delivers it to the buyer.
5. Whenever a stage closes, that holder's sensor commits the hash of its readings for the stage; the Oracle Service summarises them for each batch and submits the summary. Time between one party's sign-off and the next one's sign-in is the **handover gap**: no sensor covers it.
6. A stage is **flagged** if the sensor shows the batch above its limit for longer than the grace period, the receiver's probe is too warm, the handover gap is longer than the grace period, the goods are damaged or the seal broken or issues reported, or the sensor has no readings for longer than the grace period. A flagged stage opens a **Claim** at once, tagged to whoever held the batch on that stage.
7. Once every stage has its closing handover and verified readings, the Certificate Service issues a **LegPass** per stage and one **FinalCertificate** per batch: clean, flagged, or resolved.
8. The buyer's quality inspector rules on each claim (upheld / overturned / compensation agreed) with a note, then **releases the batch for sale or rejects it**. This moves no funds.
9. The **buyer acknowledges receipt**. This closes the batch. The printed certificate carries a QR code to a public page that verifies it against the chain.

---

## 6. Application flows

**Landing page** (public, no login) — animated hero showing a shipment moving through the six custody stops ending in a certificate checkmark; the problem; "how it works"; an impact section (illustrative numbers, clearly labelled); a "Connect Wallet" call to action.

**Login** — connect MetaMask, sign a message, backend verifies and looks up the role in ParticipantRegistry. Known wallet → that role's dashboard. Unknown wallet → a "Request Access" form for the admin to approve.

**Supplier flow** — create batches (product, quantity, buyer, inspector, limit, grace period) with a cold-room sensor → spot readings and issue reports → check and hand each batch over to Cargo.

**Custodian flow** (Cargo, handler, cold store, truck) — sign in what's handed over (with a quality check), register your sensor, record spot readings and issues, and check and hand over to the next party. Cargo also opens containers and seals them; the cold store unloads them.

**Sensor registration** — wherever a holder needs a sensor: *Register your sensor for this supply* (sensor id plus its export), *Demo simulation: compliant sensor registration*, *Demo simulation: breached sensor registration*, or a sensor registered before.

**Quality Inspector flow** — flagged stages to rule on (the evidence: both sides' checks, each holder's sensor readings, the handover gaps, on-chain verification of the readings), then the release/reject decision.

**Buyer flow** — sign deliveries in, see each batch's full record, acknowledge receipt, print the certificate.

**Admin flow** — access requests, participants (suspend), system pause, overview KPIs and the audit log.

**Public verification** — `/verify/<batchId>`, opened from the certificate's QR code: the certificate and every transaction behind it, read from the chain.

---

## 7. UI/UX requirements

- Clean, minimal, highly readable — this is a dispute-evidence tool, so clarity beats decoration.
- Consistent status colour coding: pass = green, flagged/pending review = amber, rejected/breach = red. Handover gaps (no sensor) are shaded amber and labelled.
- Card-based dashboards, generous white space, one clear primary action per screen.
- Sans-serif type (e.g. Inter), light cold-chain-appropriate palette (cool blues/teals), sparing use of thermometer/snowflake iconography.
- The landing page animation and the impact numbers should make the project's value obvious within a few seconds — this is a graded demo.
- Fully responsive; every flow above should work cleanly on a laptop screen in a 10-minute live demo. All times are real; for a short live demo, give batches short grace periods.

---

## 8. Instructions to you, the build agent

- Keep every service and contract as simple and readable as possible. Prefer straightforward code over clever abstractions — this is a 1-developer, 8-week course project, not a production system.
- Use well-known, actively maintained open-source libraries for anything security-sensitive (auth, hashing, signatures). Do not hand-roll cryptography.
- Never add payment, escrow, bonding, or token-transfer logic anywhere, even if it would be easy to bolt on.
- Build and test each slice end to end before starting the next.
- **If a requirement here is ambiguous, or a design decision isn't specified, stop and ask rather than assuming.**

---

## 9. Out of scope (do not build)

Payment, escrow, bonds, consumer-facing traceability, real IoT hardware, testnets other than Sepolia, machine-learning spoilage prediction, insurance claim automation.
