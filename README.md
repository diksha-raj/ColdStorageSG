# ColdChainSG

A prototype for tracking chilled food shipments, by air or sea, through Singapore's cold chain. Every party that holds a batch covers it with its own sensor and signs it in and out; the platform pins any problem to the stage and the firm where it happened, and issues a tamper-evident quality certificate. It's a neutral evidence layer: **it never moves money**.

DBA5102 Blockchain course project. Build brief (kept in step with the app): [docs/brief.md](docs/brief.md). Design decisions and every change from the brief: [docs/decisions.md](docs/decisions.md). Live demo run sheet: [docs/demo-script.md](docs/demo-script.md).

## Architecture

![ColdChainSG architecture](docs/architecture.jpg)

How the diagram maps to the code (the diagram predates the sensor gateway; it sits beside the other services):

| In the diagram | In the repo |
| --- | --- |
| Web app | `frontend/` (React + Vite). Calls the services over REST. |
| Chain client / MetaMask | The web app's `frontend/src/lib/chain.ts`. Participants sign their own batch, container, sensor, handover, ruling, decision and acknowledgement transactions in MetaMask. |
| Backend services | `services/identity-service`, `custody-service`, `sensor-gateway`, `oracle-service`, `certificate-service`. Each stores its off-chain data in its own Postgres schema. |
| Shared auth and RPC module | `services/common/`: Sign-In with Ethereum sessions, role lookups and the connection to the chain node. It runs in the backend (off-chain) and is shared by all five services. |
| Blockchain layer: Identity | `contracts/contracts/ParticipantRegistry.sol`: wallets, roles, system pause |
| Blockchain layer: Custody | `contracts/contracts/ShipmentCustody.sol`: batches, containers, each stage's sensor, two-step handovers with both sides' signed checks and their times, sealing, unloading |
| Blockchain layer: Certificates | `contracts/contracts/CertificateRegistry.sol`: stage flags, claims, QA rulings and decisions, certificates, acknowledgement |
| Blockchain layer: Evidence | `contracts/contracts/SensorOracle.sol`: each stage's readings hash (committed by the sensor) and per-batch summaries |

On-chain: wallets and roles; batches, containers, seal and container numbers; which sensor covered each stage; every handover's two signed checks and their timestamps; each stage's readings hash and per-batch summary; flags, claims, rulings, decisions and certificates. Off-chain (Postgres): organisation details, product and voyage details, spot readings, issue reports, notes and the sensor readings themselves. Their fingerprints are on-chain, so any later edit is detectable.

## How a shipment moves

| Stage | Holder | Their sensor | Handover that closes it |
| --- | --- | --- | --- |
| 0 | **Supplier** | cold-room sensor | signs each batch off to Cargo, which signs it in **straight into its container** |
| 1 | **Cargo** (air or sea) | the container's sensor | seals the container and signs it off to the handler |
| 2 | **Destination Freight Handler** | the same container sensor, still reading | signs the container off to the cold store |
| 3 | **Cold Store** | cold-room sensor | unloads the container, signs each batch off to a reefer truck |
| 4 | **Reefer Truck** | truck sensor | delivers each batch to its buyer |

- **The supplier creates batches** with their buyer, quality inspector, max temperature and grace period (fixed on-chain), and registers its cold-room sensor for them.
- **Cargo opens a container** by air or sea. It can type the container's real ISO 6346 number (checked on-chain, check digit included) or leave it blank to have one generated. It registers the container's sensor, receives batches into it, and **seals it** after loading. The seal number is on-chain, fixed once the container leaves Cargo, and printed on the certificate.
- **Registering a sensor** is a dropdown wherever a holder needs one: *Register your sensor for this supply* (a sensor id and its export), *Demo simulation: compliant sensor registration*, *Demo simulation: breached sensor registration*, or one you registered before. The **sensor gateway** gives each sensor its own device key. When a stage closes, the sensor commits the hash of its readings on-chain, and the oracle summarises them for each batch.
- **Every handover is two signatures.** The sender signs it off (the **exit** time) with a probe temperature and condition; the receiver signs it in (the **entry** time) with what they found, *Accept* or *Accept with issues*. There's no rejection. The time between the two is the **handover gap**: on the dock, unrefrigerated, no sensor. It's shown amber.
- **A stage is flagged, permanently,** if its sensor shows the batch above its limit for longer than the grace period, the receiver's probe is too warm, the handover gap is longer than the grace period, there's damage, a broken seal or a reported issue, or the sensor sent no readings for longer than the grace period. A claim opens straight away, often mid-journey, tagged to whoever held the batch.
- **The buyer's quality inspector** rules on each flagged stage (upheld, overturned or compensation agreed), then signs a final **Release for sale** or **Reject**. The buyer then acknowledges receipt, which closes the batch.
- **The certificate** is printable (A4, *Print / Save as PDF*) and carries a QR code to `/verify/<batchId>`: a public page that reads the certificate and every transaction behind it straight from the chain, no sign-in needed.
- **The admin** only runs the platform: approves and suspends participants, can pause the system, and sees the overview and the audit log.
- **Simulated sensors follow the shipment's spec:** a demo compliant sensor holds about 1.5 °C below the tightest limit of the batches it covers (a −10 °C batch sees about −11.5 °C); a demo breached one fails a minute after registration and climbs about 5.5 °C above the loosest limit. They read every 10 seconds.
- **All times are real**: entry, exit, handover gaps, excursions and grace periods are real minutes. For a short live demo, give batches short grace periods (e.g. 2 minutes).

See [docs/demo-script.md](docs/demo-script.md) for the 10-minute walkthrough and [docs/decisions.md](docs/decisions.md) for why things work this way.

## Prerequisites

- Node 20+ (developed on Node 26)
- Postgres 16.
  `brew install postgresql@16`, set `port = 5433` in `/opt/homebrew/var/postgresql@16/postgresql.conf`, `brew services start postgresql@16`, `createdb -p 5433 coldchainsg`

## Run locally

```bash
npm install
cp .env.example .env            # then fill in JWT_SECRET (command is in the file)

npm run chain                   # terminal 1: local Hardhat node on :8545
npm run deploy                  # terminal 2: deploy contracts (also resets local DB tables)
npm start -w services/identity-service     # :4001  (one terminal each, or background them)
npm start -w services/custody-service      # :4002
npm start -w services/oracle-service       # :4003  (summarises sensor readings)
npm start -w services/certificate-service  # :4004  (runs the certificate sync loop)
npm start -w services/sensor-gateway       # :4005  (sensor device keys; commits readings)
npm run seed                    # onboard the nine demo organisations; prints MetaMask keys
npm run web                     # frontend on http://localhost:5173
```

The chain resets every time `npm run chain` restarts. After a restart, re-run `npm run deploy`, restart the services, and run `npm run seed`.

### MetaMask for the demo

1. Import the private keys printed by `npm run seed` (Admin plus nine demo organisations). These are Hardhat's **public test keys**, so use them on the local chain only.
2. The first sign-in adds the "ColdChainSG Local (Hardhat)" network (chain 31337, `http://127.0.0.1:8545`) to MetaMask automatically.
3. **After restarting the chain**, MetaMask still remembers old nonces. In MetaMask, go to *Settings → Advanced → Clear activity tab data* for each account, or transactions will fail with "nonce too high".
4. Switching accounts in MetaMask signs you out of the app, so actions are never sent from the wrong wallet.

## Tests

```bash
npm run test:all
```

This runs **every suite against an isolated stack**, so your demo data is never touched. The isolated stack is a second chain on :8546, a `coldchainsg_e2e` database, services on :4101–4105 and the web app on :5174. Only Postgres needs to be running.

| Suite | What it covers |
| --- | --- |
| browser | The whole demo through the UI in Chrome: onboarding; batches with a cold-room sensor; Cargo's container with its own sensor export; a sensor excursion, a warm receipt and a long dock time flagged for the 4 °C batch but not the 8 °C one; a demo "breached" truck sensor; QA rulings with on-chain verification of the readings; the printable certificate (saved as a PDF) and its public verification page. Screenshots go to `frontend/e2e/screenshots/`. |
| contracts | Solidity unit tests: every state protection, every flag rule, entry/exit windows and handover gaps |
| identity / custody / oracle / certificate | Each service end-to-end against the real chain and database (the oracle suite covers the sensor gateway's API, commits and tamper detection) |
| gateway | The simulated sensors: compliant and breached readings, attached exports, deterministic hashes |

`npm run test:contracts` runs just the Solidity tests (in-process; nothing needs to be running). `npm run slither` runs static analysis against `contracts/slither-baseline.txt`.

## Known limitations

- **The local chain is in memory.** `npm run chain` runs Hardhat's development node, which keeps nothing on disk. Stopping it (or restarting the computer) erases every contract and record. After a restart, `npm run deploy` also resets the off-chain tables so they don't point at shipments that no longer exist, and the demo has to be seeded again.
- **Sensors are simulated.** There's no IoT hardware. A demo sensor's readings are generated from the covered batches' limits (compliant, or failing a minute after registration); an "own" sensor's attached export is replayed minute by minute as its live feed. The gateway holds every device key, as a vendor's platform would; real devices would sign on the device.
- **Entry and exit are the signature times.** A handover's timestamps are when each party signed, not when the goods physically moved.
- **Demo wallets use Hardhat's public test keys.** They're fine on the local chain and must never be used on a real network.

## Layout

```
contracts/              Solidity + Hardhat 3 (tests in contracts/test)
services/common/        shared env, db, chain, auth (SIWE session JWT), http and test helpers
services/*-service/     one Express API per service, each with its own Postgres schema
services/sensor-gateway the simulated sensor platform: device keys, readings, on-chain commits
frontend/               React + Vite + Tailwind; e2e/ holds the browser test
data/raw/               sample sensor exports to attach as "your sensor" (regenerate: npx tsx data/generate.ts)
deployments/            contract addresses + ABIs written by the deploy script
docs/                   build brief, design decisions, demo run sheet, architecture diagram
```
