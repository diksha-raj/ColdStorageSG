# Design decisions

These fill gaps in the build brief. Each one was agreed before implementation. Later sections change
earlier rows; a changed row is marked **Superseded** or **Updated** with the row that replaced it, and
is otherwise left as it was decided, as a record. The app does what the latest row says.

| # | Question | Decision |
| --- | --- | --- |
| 1 | Who signs transactions for user actions? | **Users sign in MetaMask.** Custodians, inspectors and buyers send their own transactions, so `msg.sender` is the real wallet. Services sign only oracle, admin and certificate actions with their own server wallets. |
| 2 | Database | **Postgres 16** (installed with Homebrew), one instance, one schema per service (`identity`, `custody`, `oracle`, `certificate`). |
| 3 | Which legs report sensor data? | **Superseded by #42-#43:** every stage, the supplier's included, now has its holder's own sensor. **4 legs. The supplier is off-platform** (just the container's `origin` field, not a wallet). Leg 1 Carrier, leg 2 Handler, leg 3 Cold store (container level, before the split), leg 4 Truck (per batch). Batches inherit legs 1–3 from their container. |
| 4 | How is a tampered CSV detected? | **Updated by #43:** each sensor now has its own device key, held by the sensor gateway, and commits its readings, not an uploaded file. **The sensor commits first.** The registered sensor (a simulated device key) commits the SHA-256 of its raw file at the end of each leg. The oracle then submits a summary with the hash of the file it replayed. If the two hashes differ, the leg is marked `EvidenceMismatch` and gets no LegPass until it's resubmitted. |
| 5 | Who is the "assigned inspector"? | **A separate Inspector role.** When adding a batch, the importer picks both a buyer wallet and an inspector wallet. Both are stored on-chain. |
| 6 | What does a resolution do to a flagged certificate? | **A `resolved` status is added.** Final status is `clean` / `flagged` / `resolved`. When every claim on a batch has a resolution, `flagged` becomes `resolved`. Each claim keeps its own outcome. |
| 7 | Which chain? | **A local Hardhat node** for development and the demo, using funded test accounts imported into MetaMask. A Sepolia network config and deploy script are included but optional. |

## Standing rules from the brief

- No payment, escrow, bond or token-transfer logic anywhere.
- The admin can pause the whole system. The pause flag lives in `ParticipantRegistry`, and the other contracts check it.

## Made while building slice 2 (confirmed 2026-10-02)

| # | Question | Current implementation |
| --- | --- | --- |
| 8 | Who hands the container to the carrier, given the supplier is off-platform? | **Superseded by #40:** the supplier is on-platform and signs batches off to Cargo itself. The **importer** holds custody at the `Origin` stage, standing in for the supplier, and starts the first handover to the carrier. |
| 9 | Which sensor covers leg 4, after the batches have split up? | **Superseded by #42:** stage 4 is covered by the reefer truck's own sensor. **Each batch has its own sensor ID**, entered by the importer in `addBatch`. The container's sensor covers legs 1–3. |
| 10 | When does leg 3 (cold store) end? | **Superseded by #45:** stage 3 runs from the cold store's sign-in to its sign-off to the truck. **At the split.** The time between the split and truck pickup is custody-tracked (the cold store holds the batch) but has no sensor leg. *Alternative:* end leg 3 per batch at truck pickup, which closes the gap but makes leg 3 per batch. |
| 11 | Can a batch's threshold or grace period change later? | **Updated by #40:** fixed in `createBatch`. **No.** Both are fixed in `addBatch`, before dispatch, so the rules can't change after the evidence exists. |
| 12 | How is the route enforced? | **By role, in a fixed order** (Carrier → Handler → Cold store → Truck → the batch's own buyer). The current custodian picks the specific wallet at each handover. |

## Made while building slice 3 (confirmed 2026-10-02)

| # | Question | Current implementation |
| --- | --- | --- |
| 13 | What does the grace period measure? | **The longest single continuous excursion** above the batch's threshold. `breach_minutes` is that excursion's length. A leg is flagged when it exceeds the grace period (applied in slice 4). Several short blips under the grace period don't add up. |
| 14 | How do CSV timestamps line up with on-chain custody times? | **Superseded by #45/#48:** readings carry real (chain) times; nothing is rebased. **The replay rebases the file onto the leg.** The first reading is placed at the leg's on-chain start (the handover) and the rest keep their spacing. A demo leg may last only seconds, so a breach can land after the leg's end time. Claims will therefore be tagged to the **custodian of the leg the file belongs to**, not resolved with `getCustodianAt(breach_start)`. |
| 15 | A container leg has one sensor file but batches with different thresholds. How is that handled? | **The sensor commits once per file; the oracle submits a summary per batch**, each judged against that batch's own threshold. |
| 16 | Do the simulated sensors have their own keys? | **Superseded by #43:** each sensor has its own device key. **No. All demo sensors report through one simulated device key** (`SENSOR_PRIVATE_KEY`, Hardhat #3), like a gateway. Each sensor ID is still registered separately, and an unregistered sensor ID is rejected. |
| 17 | Can accepted evidence be replaced? | **No.** Once a leg is `Verified`, later replays leave it unchanged (`AlreadyVerified`). Only an `EvidenceMismatch` can be resubmitted. |

## Made while building slice 4 (confirmed 2026-10-03)

| # | Question | Current implementation |
| --- | --- | --- |
| 18 | Who decides pass or flagged? | **The contract does**, from the verified summary: flagged when `breach_minutes > grace_minutes`, so an excursion exactly equal to the grace period passes. The certifier can't choose the verdict. |
| 19 | What is automatic and what is manual? | **Updated by #46:** five stages, each needing verified readings. **The Certificate Service does these automatically**, in a sync loop every 3 s: issue LegPasses, open a claim for each flagged leg, and issue the final certificate once all 4 legs have LegPasses. **People sign these in MetaMask:** resolutions (the inspector) and acknowledgement (the buyer). |
| 20 | Can the buyer acknowledge while claims are still open? | **No.** Acknowledgement needs a final certificate that is `clean` or `resolved`. It "closes the batch", so everything must be settled first. |
| 21 | Can an inspector resolve a claim before the final certificate exists? | **Yes.** The certificate is then issued directly as `resolved`. |
| 22 | Off-chain inspection notes | **Text notes only** (no photos), added to a claim by the batch's inspector or buyer. They are separate from the signed on-chain resolution note. |

## Changed on 2026-10-03: custodians upload their own leg's sensor log

This replaces the admin-only CSV replay panel the brief described ("Oracle / demo control"). The project owner chose it so that temperature evidence arrives leg by leg, from the parties involved.

| # | Question | Current implementation |
| --- | --- | --- |
| 23 | Who submits a leg's temperature log? | **Superseded by #42-#44:** nobody uploads logs; each holder's sensor reports through the gateway. **The custodian who held that leg.** After handing over, they upload the logger file from their dashboard: a demo file, or a CSV from their computer. Only that leg's custodian can upload, and only after the leg has ended. |
| 24 | What stops a custodian uploading a cleaned-up log? | **Superseded by #43:** the sensor commits its own readings. **The sensor's own commit.** When a leg ends, the simulated sensor automatically commits the SHA-256 of what it actually recorded. An upload that doesn't match is recorded on-chain as `EvidenceMismatch`, and no LegPass is issued until the genuine log is uploaded. |
| 25 | What decides what the sensor "actually recorded"? | **Superseded by #44/#49:** the holder picks how a demo sensor reads when registering it; the admin has no part. **The admin's demo panel** ("What the sensors record"), a stand-in for physical reality. Each leg is *compliant* by default or *breach*, and must be set before the leg ends. It locks once the sensor commits. The admin no longer submits evidence. |
| 26 | Who signs the on-chain summary? | **Updated by #47:** the oracle summarises the sensor's committed readings. **The oracle service, still.** It hashes and summarises the uploaded file. The uploader's wallet is recorded off-chain and shown on the evidence card. No contract changes. |

## Changed on 2026-10-05: quality checks at every handover, and a clear QA role

Confirmed with the project owner.

| # | Question | Decision |
| --- | --- | --- |
| 27 | How do custodians record quality? | **Updated by #45:** checks no longer carry typed unrefrigerated minutes; the dock time is measured from the signatures. **A two-sided checkpoint at every handover.** The sender signs an outgoing check in `initiateTransfer`: probe temperature at dispatch, minutes unrefrigerated during their custody, packaging condition, seal, and issues during the leg. The receiver signs an incoming check in `acceptTransfer`: probe temperature on receipt, minutes waiting at the handover, condition, seal, and *Accept* or *Accept with issues*. The importer's dispatch is **stage 0 (Origin)**, so each batch has five stages. The cold store's checkpoint is per batch, at truck pickup. |
| 28 | What's on-chain and what isn't? | **The checks are on-chain**, inside the handover transactions, so there are no extra MetaMask pop-ups. Spot readings and issue reports during a leg are saved off-chain immediately. At handover they're frozen into a JSON snapshot with the note, and its keccak256 is the check's `notesHash`. The custody service stores the exact JSON, so anyone can re-hash it and compare. |
| 29 | Can a receiver reject a handover? | **No.** There's no send-back and no re-chilling. The receiver always takes custody and records what they found. A failed check **permanently** flags that stage, which then shows at every later stage and goes to QA. |
| 30 | What flags a stage? | **Updated by #46:** the handover gap replaces typed unrefrigerated minutes, and missing readings also flag. Any of: receipt temperature above the batch's limit; sender's plus handover unrefrigerated minutes above the grace period; damage, a broken seal, *Accept with issues*, or issues the sender reported. The sensor log (kept, see #23–26) adds a fourth reason: an excursion longer than the grace period. A sender-vs-receiver temperature gap is **shown but doesn't flag**. Flags are computed on-chain per batch, using each batch's own limit and grace period. |
| 31 | When do claims open? | **Updated by #46:** a stage-0 claim is tagged to the supplier. **As soon as a stage is flagged.** For a checkpoint flag that's at the handover, while the batch is still in transit. For a sensor flag, it's when the log is verified. The claim is tagged to whoever held the batch on that stage (the importer at Origin). |
| 32 | What does QA do? | **Two jobs.** (1) Rule on each flagged stage, as soon as it's flagged: upheld, overturned, or compensation agreed. (2) After the final certificate, once every flagged stage has a ruling, sign a **disposition** for the batch: *Release for sale* or *Reject*, with a reason. The buyer can only acknowledge receipt after the disposition, which closes the batch. |

## Changed on 2026-10-15: sensor logs are uploaded at handover

Requested by the project owner. Replaces the timing in #23 ("after handing over"). No contract change.

| # | Question | Decision |
| --- | --- | --- |
| 33 | When does a custodian upload their leg's sensor log? | **Superseded by #42-#44:** no uploads. **At the handover that ends their leg, before handing over:** upload the log, then hand over. The carrier, handler and truck pick it in the "Check & hand over" form (legs 1, 2, 4). The cold store picks it in **Upload log & split**, since the split ends leg 3. The log is held off-chain (`oracle.staged_uploads`) and checked against the sensor's commit automatically once the receiver accepts and the sensor reports. A mismatch then shows on the sender's Sensor logs card, where they can upload the genuine log, which is checked straight away. |

## Changed on 2026-10-16: Solidity version pinned

Requested by the project owner. No change in behaviour or ABI.

| # | Question | Decision |
| --- | --- | --- |
| 34 | Which compiler versions may the contracts be built with? | **Exactly 0.8.34**, the version in `hardhat.config.ts`. All four contracts declare `pragma solidity 0.8.34;` instead of the floating `^0.8.24`, so the bytecode tested and deployed can only come from that compiler. `contracts/test/Pragma.ts` fails if a contract's pragma ever drifts from the configured compiler. Slither had no finding to accept: its version warnings were only for OpenZeppelin's files, which the check excludes. The deployed demo contracts behave identically, so they weren't redeployed. |

## Changed on 2026-10-16: public certificate verification

Requested and confirmed by the project owner. No contract change.

| # | Question | Decision |
| --- | --- | --- |
| 35 | How can someone holding a printed certificate check it's genuine? | **Scan its QR code.** It opens a public page, `/verify/<batchId>`, with no sign-in. The page reads the certificate, stage verdicts, QA rulings and decision, buyer's acknowledgement, and **every transaction that touched the batch, its container or its claims** straight from the chain node, not through the services. Each transaction shows who signed it, the decoded call, its events and its receipt. The QR link carries the chain id and CertificateRegistry address the certificate was printed from, and the page warns if it's reading a different one. Wallets are labelled with organisation name and role from a public `GET /directory` (identity service), which never returns contact details. The printed certificate also shows the transaction that issued it. On the local chain the link only works on the machine running the demo. |

## Changed on 2026-10-16: container numbers and seal numbers

Requested by the project owner; format and seal handling chosen by them. Contract change (`ShipmentCustody`), so the demo chain must be redeployed.

| # | Question | Decision |
| --- | --- | --- |
| 36 | What identifies a container? | **Updated by #40:** Cargo opens containers (and enters the number). **An 11-character ISO 6346 number.** The importer may type the physical container's number when creating it (`createContainer(sensorId, code)`); the contract checks the format (three-letter owner code, category `U`, six digits) and the check digit, and rejects a typo. Real containers are reused, so a number is blocked only while another shipment with it is active, i.e. until that container is split at the cold store (`activeContainerByCode`). Owner code `CCS` is reserved for generated numbers, so a typed number can't collide with one. **If the importer leaves it blank, it's generated on-chain**: owner code `CCS`, category `U`, a six-digit serial and the standard check digit (e.g. `CCSU1126480`). The serial is the internal id through a fixed permutation of 0–999,999 (`(id × 7919 + 104729) mod 10⁶`; 7919 is coprime with 10⁶), so numbers are unique without extra storage and don't look sequential. It's stored as `Unit.code`, emitted in `ContainerCreated`, and copied to each batch. The numeric id stays the internal key, as real containers are reused across trips. Batches keep their `Batch #N` label. The contract test checks the check digit against an independent ISO 6346 implementation and published examples. |
| 37 | Who records the seal number, and when? | **Superseded by #41:** Cargo records the seal after loading. **The importer, at stage 0, before dispatch** (in reality the shipper applies the seal after loading; our supplier is off-platform, so the importer acts for them). `recordSeal(containerId, sealNumber)` stores it on the container; it can be corrected until the carrier transfer is initiated and is then fixed. `initiateTransfer` at origin requires it. Receivers don't re-enter the number: they keep the *Seal intact* tick box (#27, #30), with the recorded number shown to compare against. The certificate and the public verify page show the seal number and whether it was reported intact at each container handover until the cold store opened it for the split. No truck seal is recorded for leg 4. Slither: two `timestamp` findings on `recordSeal` and `initiateTransfer` accepted into the baseline. They're the same false positive as the existing ones (the detector flags any comparison in a function that touches a struct holding timestamps); no comparison involves a timestamp. |

## Changed on 2026-10-16: "Importer" renamed to "Supplier"

Requested by the project owner. A rename only: the role does exactly what it did before. Contract change (role constant, field and event names), so the demo chain must be redeployed.

| # | Question | Decision |
| --- | --- | --- |
| 38 | What is the party that creates containers and dispatches them called? | **Updated by #40:** the supplier now creates batches only; Cargo creates containers. **Supplier.** The `IMPORTER` role is now `SUPPLIER` everywhere: the on-chain role (`keccak256("SUPPLIER")`), `Unit.supplier`, event arguments, error messages, services, frontend and seed (organisation "Merlion Fresh Supplies"). The cold store's label drops its owner and is just **Cold store** (role `COLD_STORE` unchanged). Nothing else changes: the supplier creates the container and batches, assigns buyers, records the seal and dispatches at stage 0, and stage 0 claims are tagged to the supplier. "Importer" in `docs/brief.md` and in decisions #1–37 now means this supplier role; those texts are left as written. |

## Changed on 2026-10-17: mode-neutral stage labels

Requested by the project owner, so the app isn't tied to air freight: a shipment may go by air or sea. Labels only; no contract, role or flow change.

| # | Question | Decision |
| --- | --- | --- |
| 39 | What are the parties and stages called in the app? | **Supplier → Cargo → Destination Freight Handler → Cold Store → Reefer Truck → Buyer, with the Quality Inspector** (previously Air carrier, Changi handler, Cold store, Delivery truck, QA inspector). The roles behind them are unchanged (`CARRIER`, `HANDLER`, `COLD_STORE`, `TRUCK`, `INSPECTOR`), as are the stage enum names in the contracts. Air-specific wording ("in flight", "Changi", plane icons) is replaced with neutral wording. The demo organisation "Equator Air Cargo" keeps its name. "Air carrier" and "Changi handler" in `docs/brief.md` and decisions #1–38 mean the Cargo and Destination Freight Handler roles. |

## Changed on 2026-10-17: every holder's own sensor; supplier and Cargo in their real roles

Requested and confirmed by the project owner, so the flow matches how chilled freight actually moves. Contract changes to ShipmentCustody, SensorOracle and CertificateRegistry, a new sensor-gateway service, and a redeploy.

| # | Question | Decision |
| --- | --- | --- |
| 40 | Who creates batches and containers? | **The supplier creates batches** (`createBatch`: buyer, inspector, max temperature, grace period) and holds them at stage 0. **Cargo opens containers** (`createContainer`, ISO 6346 number entered or generated, #36) and **signs each batch in straight into one of its open containers** (`acceptIntoContainer`). While inside, a batch moves with its container: each container handover moves every batch's custody. The cold store **unloads** the container (`unloadContainer`); batches then go on singly. |
| 41 | Who seals the container? | **Cargo, after loading** (`recordSeal`, which needs at least one batch inside; no batch can be received once sealed). It's required before the container is handed on and fixed after. Receivers tick *Seal intact*, with the number shown; the certificate shows it and whether it stayed intact through both container handovers. |
| 42 | Which sensor covers which stage, and who registers it? | **Each holder registers its own sensor for the stage it holds** (`ShipmentCustody.registerSensor(ids, sensorId, device)`): stage 0 the supplier's cold room, stages 1-2 Cargo's container sensor (it keeps reading while the handler holds the container, so the handler registers none), stage 3 the cold store's room, stage 4 the reefer truck. One sensor can cover many units; a sensor id belongs to whoever first registered it, on one device. A stage can't be signed off until its sensor is registered. |
| 43 | Who signs a sensor's readings? | **The sensor itself, through a sensor gateway** (`services/sensor-gateway`), standing in for the sensor vendor's platform. Each sensor gets its own device key, derived from the gateway's key and funded by it. When a stage closes (the receiver signs in), the sensor commits the SHA-256 of its readings for that window (`SensorOracle.commitFileHash`); the file is kept byte for byte and served publicly so anyone can re-hash it. |
| 44 | How does a participant register a sensor? | **Updated by #51:** demo sensors now read relative to the covered batches' limits, every 10 seconds, and a breached one fails after 1 minute. **A dropdown with three options**, plus any sensor they registered before: *Register your sensor for this supply* (a sensor id and its export: the prototype can't reach real devices, so the export is read minute by minute from registration as the live feed, and readings stop when it runs out); *Demo simulation: compliant sensor registration* (a chilled 1.8-3.4 °C); *Demo simulation: breached sensor registration* (refrigeration fails 3 minutes after registration and climbs to about 9.5 °C). Demo readings are generated on the fly, deterministically, so the same window always gives the same hash. |
| 45 | What are a stage's entry and exit, and what is the handover gap? | **Exit is the moment the sender signs the unit off; entry is the moment the receiver signs it in** (the two checks' block timestamps). A stage runs from its holder's entry to its exit, except stage 1, which runs until the handler signs the container in, because the container's sensor reads through that handover. The time from sign-off to sign-in is the handover gap: on the dock, unrefrigerated, no sensor. It's measured on-chain (`handoverGapMinutes`), shown amber, and replaces the typed "minutes without refrigeration", which was removed from the checks. |
| 46 | What flags a stage now? | Any of: the stage's verified readings above the batch's limit for longer than the grace period (all five stages, the supplier's included); the receiver's probe above the limit; **a handover gap longer than the grace period** (`FLAG_HANDOVER_GAP`); damage, a broken seal, *Accept with issues* or issues the sender reported; **no readings for longer than the grace period** (`FLAG_MISSING_DATA`). Every stage needs verified readings for its LegPass. A claim is tagged to whoever held the batch on that stage (the supplier at stage 0). |
| 47 | What does the oracle do now? | **It summarises committed readings, per batch.** It fetches the sensor's file for the window, takes the batch's own entry and exit inside it, judges it against the batch's limit (longest run above, minutes without readings, min and max), and submits the summary with the hash of the file it used. A different hash means the readings were altered after the sensor reported: the stage is `EvidenceMismatch` and blocked. Its evidence view (`/evidence/<batchId>`) is public, like the certificate it backs. |
| 48 | How does the demo show minutes in a few seconds? | **Superseded by #50:** there is no demo clock; all times are real. **A demo clock.** `ShipmentCustody.timeScale` (immutable; 60 on the local and test chains, 1 anywhere else) says how many minutes a real minute counts as. Sensors read once per simulated minute (a second at 60x), and gaps and excursions are measured in simulated minutes, so a 15-minute grace period means something in a live demo. Times shown are real block timestamps. Tests move the test chain's clock instead of waiting. |
| 49 | What does the admin do? | **Runs the platform only:** approves and suspends participants, pauses the system, sees the overview and the audit log. The admin's Sensors and Demo control screens were removed; shipments and sensors belong to the participants. Seeding registers organisations only. |

Slither: the new findings were accepted into the baseline after review. They are the existing false-positive kinds: `timestamp` on functions whose flagged comparisons are on roles, stages and addresses (the only timestamp arithmetic is the handover gap, which is meant to measure time), `incorrect-equality` on an enum comparison, and `unused-return` where only some fields of a returned tuple are needed.

## Changed on 2026-10-17: real time, and simulated sensors that follow each batch's spec

Requested by the project owner: a supplier's -10 °C batch was being judged against a sensor simulated for chilled goods, and the demo clock adjusted times. Contract change (ShipmentCustody's constructor and `handoverGapMinutes`), so a redeploy.

| # | Question | Decision |
| --- | --- | --- |
| 50 | How is time measured? | **Real time, with no adjustment.** The demo clock (#48) is removed: `ShipmentCustody` has no `timeScale`, and `handoverGapMinutes` is the real sign-off-to-sign-in time in whole minutes. Sensor readings carry real timestamps, and excursions and missing readings are real minutes. A short live demo uses short grace periods instead. The tests move the test chain's clock rather than wait. |
| 51 | What does a simulated sensor read? | **What the batches it covers need.** The gateway works out, when it produces readings, every batch the sensor is registered for on-chain (a container's batches included). A demo compliant sensor holds about 1.5 °C below the tightest of their limits (a -10 °C batch sees about -11.5 °C; a room covering 4 °C and 8 °C batches holds below 4 °C). A demo breached sensor starts the same, then its refrigeration fails 1 minute after registration and climbs over 3 minutes to about 5.5 °C above the loosest limit, so it breaches every batch it covers. Demo sensors read every 10 seconds; an attached export still reads once a minute. The oracle takes a sensor's interval from its readings (their tightest spacing) when counting minutes without readings. |

Slither: no new findings.

