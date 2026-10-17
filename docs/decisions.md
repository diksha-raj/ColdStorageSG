# Design decisions

These fill gaps in the build brief. Each one was agreed before implementation (2026-10-01).

| # | Question | Decision |
| --- | --- | --- |
| 1 | Who signs transactions for user actions? | **Users sign in MetaMask.** Custodians, inspectors and buyers send their own transactions, so `msg.sender` is the real wallet. Services sign only oracle, admin and certificate actions with their own server wallets. |
| 2 | Database | **Postgres 16** (installed with Homebrew), one instance, one schema per service (`identity`, `custody`, `oracle`, `certificate`). |
| 3 | Which legs report sensor data? | **4 legs. The supplier is off-platform** (just the container's `origin` field, not a wallet). Leg 1 Carrier, leg 2 Handler, leg 3 Cold store (container level, before the split), leg 4 Truck (per batch). Batches inherit legs 1–3 from their container. |
| 4 | How is a tampered CSV detected? | **The sensor commits first.** The registered sensor (a simulated device key) commits the SHA-256 of its raw file at the end of each leg. The oracle then submits a summary with the hash of the file it replayed. If the two hashes differ, the leg is marked `EvidenceMismatch` and gets no LegPass until it's resubmitted. |
| 5 | Who is the "assigned inspector"? | **A separate Inspector role.** When adding a batch, the importer picks both a buyer wallet and an inspector wallet. Both are stored on-chain. |
| 6 | What does a resolution do to a flagged certificate? | **A `resolved` status is added.** Final status is `clean` / `flagged` / `resolved`. When every claim on a batch has a resolution, `flagged` becomes `resolved`. Each claim keeps its own outcome. |
| 7 | Which chain? | **A local Hardhat node** for development and the demo, using funded test accounts imported into MetaMask. A Sepolia network config and deploy script are included but optional. |

## Standing rules from the brief

- No payment, escrow, bond or token-transfer logic anywhere.
- The admin can pause the whole system. The pause flag lives in `ParticipantRegistry`, and the other contracts check it.

## Made while building slice 2 (confirmed 2026-10-02)

| # | Question | Current implementation |
| --- | --- | --- |
| 8 | Who hands the container to the carrier, given the supplier is off-platform? | The **importer** holds custody at the `Origin` stage, standing in for the supplier, and starts the first handover to the carrier. |
| 9 | Which sensor covers leg 4, after the batches have split up? | **Each batch has its own sensor ID**, entered by the importer in `addBatch`. The container's sensor covers legs 1–3. |
| 10 | When does leg 3 (cold store) end? | **At the split.** The time between the split and truck pickup is custody-tracked (the cold store holds the batch) but has no sensor leg. *Alternative:* end leg 3 per batch at truck pickup, which closes the gap but makes leg 3 per batch. |
| 11 | Can a batch's threshold or grace period change later? | **No.** Both are fixed in `addBatch`, before dispatch, so the rules can't change after the evidence exists. |
| 12 | How is the route enforced? | **By role, in a fixed order** (Carrier → Handler → Cold store → Truck → the batch's own buyer). The current custodian picks the specific wallet at each handover. |

## Made while building slice 3 (confirmed 2026-10-02)

| # | Question | Current implementation |
| --- | --- | --- |
| 13 | What does the grace period measure? | **The longest single continuous excursion** above the batch's threshold. `breach_minutes` is that excursion's length. A leg is flagged when it exceeds the grace period (applied in slice 4). Several short blips under the grace period don't add up. |
| 14 | How do CSV timestamps line up with on-chain custody times? | **The replay rebases the file onto the leg.** The first reading is placed at the leg's on-chain start (the handover) and the rest keep their spacing. A demo leg may last only seconds, so a breach can land after the leg's end time. Claims will therefore be tagged to the **custodian of the leg the file belongs to**, not resolved with `getCustodianAt(breach_start)`. |
| 15 | A container leg has one sensor file but batches with different thresholds. How is that handled? | **The sensor commits once per file; the oracle submits a summary per batch**, each judged against that batch's own threshold. |
| 16 | Do the simulated sensors have their own keys? | **No. All demo sensors report through one simulated device key** (`SENSOR_PRIVATE_KEY`, Hardhat #3), like a gateway. Each sensor ID is still registered separately, and an unregistered sensor ID is rejected. |
| 17 | Can accepted evidence be replaced? | **No.** Once a leg is `Verified`, later replays leave it unchanged (`AlreadyVerified`). Only an `EvidenceMismatch` can be resubmitted. |

## Made while building slice 4 (confirmed 2026-10-03)

| # | Question | Current implementation |
| --- | --- | --- |
| 18 | Who decides pass or flagged? | **The contract does**, from the verified summary: flagged when `breach_minutes > grace_minutes`, so an excursion exactly equal to the grace period passes. The certifier can't choose the verdict. |
| 19 | What is automatic and what is manual? | **The Certificate Service does these automatically**, in a sync loop every 3 s: issue LegPasses, open a claim for each flagged leg, and issue the final certificate once all 4 legs have LegPasses. **People sign these in MetaMask:** resolutions (the inspector) and acknowledgement (the buyer). |
| 20 | Can the buyer acknowledge while claims are still open? | **No.** Acknowledgement needs a final certificate that is `clean` or `resolved`. It "closes the batch", so everything must be settled first. |
| 21 | Can an inspector resolve a claim before the final certificate exists? | **Yes.** The certificate is then issued directly as `resolved`. |
| 22 | Off-chain inspection notes | **Text notes only** (no photos), added to a claim by the batch's inspector or buyer. They are separate from the signed on-chain resolution note. |

## Changed on 2026-10-03: custodians upload their own leg's sensor log

This replaces the admin-only CSV replay panel the brief described ("Oracle / demo control"). The project owner chose it so that temperature evidence arrives leg by leg, from the parties involved.

| # | Question | Current implementation |
| --- | --- | --- |
| 23 | Who submits a leg's temperature log? | **The custodian who held that leg.** After handing over, they upload the logger file from their dashboard: a demo file, or a CSV from their computer. Only that leg's custodian can upload, and only after the leg has ended. |
| 24 | What stops a custodian uploading a cleaned-up log? | **The sensor's own commit.** When a leg ends, the simulated sensor automatically commits the SHA-256 of what it actually recorded. An upload that doesn't match is recorded on-chain as `EvidenceMismatch`, and no LegPass is issued until the genuine log is uploaded. |
| 25 | What decides what the sensor "actually recorded"? | **The admin's demo panel** ("What the sensors record"), a stand-in for physical reality. Each leg is *compliant* by default or *breach*, and must be set before the leg ends. It locks once the sensor commits. The admin no longer submits evidence. |
| 26 | Who signs the on-chain summary? | **The oracle service, still.** It hashes and summarises the uploaded file. The uploader's wallet is recorded off-chain and shown on the evidence card. No contract changes. |

## Changed on 2026-10-05: quality checks at every handover, and a clear QA role

Confirmed with the project owner.

| # | Question | Decision |
| --- | --- | --- |
| 27 | How do custodians record quality? | **A two-sided checkpoint at every handover.** The sender signs an outgoing check in `initiateTransfer`: probe temperature at dispatch, minutes unrefrigerated during their custody, packaging condition, seal, and issues during the leg. The receiver signs an incoming check in `acceptTransfer`: probe temperature on receipt, minutes waiting at the handover, condition, seal, and *Accept* or *Accept with issues*. The importer's dispatch is **stage 0 (Origin)**, so each batch has five stages. The cold store's checkpoint is per batch, at truck pickup. |
| 28 | What's on-chain and what isn't? | **The checks are on-chain**, inside the handover transactions, so there are no extra MetaMask pop-ups. Spot readings and issue reports during a leg are saved off-chain immediately. At handover they're frozen into a JSON snapshot with the note, and its keccak256 is the check's `notesHash`. The custody service stores the exact JSON, so anyone can re-hash it and compare. |
| 29 | Can a receiver reject a handover? | **No.** There's no send-back and no re-chilling. The receiver always takes custody and records what they found. A failed check **permanently** flags that stage, which then shows at every later stage and goes to QA. |
| 30 | What flags a stage? | Any of: receipt temperature above the batch's limit; sender's plus handover unrefrigerated minutes above the grace period; damage, a broken seal, *Accept with issues*, or issues the sender reported. The sensor log (kept, see #23–26) adds a fourth reason: an excursion longer than the grace period. A sender-vs-receiver temperature gap is **shown but doesn't flag**. Flags are computed on-chain per batch, using each batch's own limit and grace period. |
| 31 | When do claims open? | **As soon as a stage is flagged.** For a checkpoint flag that's at the handover, while the batch is still in transit. For a sensor flag, it's when the log is verified. The claim is tagged to whoever held the batch on that stage (the importer at Origin). |
| 32 | What does QA do? | **Two jobs.** (1) Rule on each flagged stage, as soon as it's flagged: upheld, overturned, or compensation agreed. (2) After the final certificate, once every flagged stage has a ruling, sign a **disposition** for the batch: *Release for sale* or *Reject*, with a reason. The buyer can only acknowledge receipt after the disposition, which closes the batch. |

## Changed on 2026-10-15: sensor logs are uploaded at handover

Requested by the project owner. Replaces the timing in #23 ("after handing over"). No contract change.

| # | Question | Decision |
| --- | --- | --- |
| 33 | When does a custodian upload their leg's sensor log? | **At the handover that ends their leg, before handing over:** upload the log, then hand over. The carrier, handler and truck pick it in the "Check & hand over" form (legs 1, 2, 4). The cold store picks it in **Upload log & split**, since the split ends leg 3. The log is held off-chain (`oracle.staged_uploads`) and checked against the sensor's commit automatically once the receiver accepts and the sensor reports. A mismatch then shows on the sender's Sensor logs card, where they can upload the genuine log, which is checked straight away. |

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
| 36 | What identifies a container? | **An 11-character ISO 6346 number.** The importer may type the physical container's number when creating it (`createContainer(sensorId, code)`); the contract checks the format (three-letter owner code, category `U`, six digits) and the check digit, and rejects a typo. Real containers are reused, so a number is blocked only while another shipment with it is active, i.e. until that container is split at the cold store (`activeContainerByCode`). Owner code `CCS` is reserved for generated numbers, so a typed number can't collide with one. **If the importer leaves it blank, it's generated on-chain**: owner code `CCS`, category `U`, a six-digit serial and the standard check digit (e.g. `CCSU1126480`). The serial is the internal id through a fixed permutation of 0–999,999 (`(id × 7919 + 104729) mod 10⁶`; 7919 is coprime with 10⁶), so numbers are unique without extra storage and don't look sequential. It's stored as `Unit.code`, emitted in `ContainerCreated`, and copied to each batch. The numeric id stays the internal key, as real containers are reused across trips. Batches keep their `Batch #N` label. The contract test checks the check digit against an independent ISO 6346 implementation and published examples. |
| 37 | Who records the seal number, and when? | **The importer, at stage 0, before dispatch** (in reality the shipper applies the seal after loading; our supplier is off-platform, so the importer acts for them). `recordSeal(containerId, sealNumber)` stores it on the container; it can be corrected until the carrier transfer is initiated and is then fixed. `initiateTransfer` at origin requires it. Receivers don't re-enter the number: they keep the *Seal intact* tick box (#27, #30), with the recorded number shown to compare against. The certificate and the public verify page show the seal number and whether it was reported intact at each container handover until the cold store opened it for the split. No truck seal is recorded for leg 4. Slither: two `timestamp` findings on `recordSeal` and `initiateTransfer` accepted into the baseline. They're the same false positive as the existing ones (the detector flags any comparison in a function that touches a struct holding timestamps); no comparison involves a timestamp. |

## Changed on 2026-10-16: "Importer" renamed to "Supplier"

Requested by the project owner. A rename only: the role does exactly what it did before. Contract change (role constant, field and event names), so the demo chain must be redeployed.

| # | Question | Decision |
| --- | --- | --- |
| 38 | What is the party that creates containers and dispatches them called? | **Supplier.** The `IMPORTER` role is now `SUPPLIER` everywhere: the on-chain role (`keccak256("SUPPLIER")`), `Unit.supplier`, event arguments, error messages, services, frontend and seed (organisation "Merlion Fresh Supplies"). The cold store's label drops its owner and is just **Cold store** (role `COLD_STORE` unchanged). Nothing else changes: the supplier creates the container and batches, assigns buyers, records the seal and dispatches at stage 0, and stage 0 claims are tagged to the supplier. "Importer" in `docs/brief.md` and in decisions #1–37 now means this supplier role; those texts are left as written. |

## Changed on 2026-10-17: mode-neutral stage labels

Requested by the project owner, so the app isn't tied to air freight: a shipment may go by air or sea. Labels only; no contract, role or flow change.

| # | Question | Decision |
| --- | --- | --- |
| 39 | What are the parties and stages called in the app? | **Supplier → Cargo → Destination Freight Handler → Cold Store → Reefer Truck → Buyer, with the Quality Inspector** (previously Air carrier, Changi handler, Cold store, Delivery truck, QA inspector). The roles behind them are unchanged (`CARRIER`, `HANDLER`, `COLD_STORE`, `TRUCK`, `INSPECTOR`), as are the stage enum names in the contracts. Air-specific wording ("in flight", "Changi", plane icons) is replaced with neutral wording. The demo organisation "Equator Air Cargo" keeps its name. "Air carrier" and "Changi handler" in `docs/brief.md` and decisions #1–38 mean the Cargo and Destination Freight Handler roles. |
