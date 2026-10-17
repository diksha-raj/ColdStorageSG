# Demo run sheet (about 15 minutes)

The story: **two batches go by sea from Melbourne to Singapore. The salmon warms up at three points; the cheese, with looser limits, doesn't. Every holder's own sensor and every signed handover show where, who held it and for how long, and QA decides, without any firm having to chase anyone for evidence.**

All times are real. To fit the demo in minutes, the batches get short grace periods: salmon 2 minutes, cheese 10.

## Before the session (about 5 minutes)

1. Start everything fresh:
   - `npm run chain`
   - `npm run deploy`
   - start the five services (identity, custody, oracle, certificate, sensor gateway)
   - `npm run seed`
   - `npm run web`
2. In MetaMask, import the keys that `npm run seed` printed. Connect each account to localhost:5173 the first time you use it. If the chain was restarted since you last imported them, clear each account's activity (Settings → Advanced → Clear activity tab data).
3. Have `data/raw/reefer-excursion.csv` to hand: it's Cargo's reefer controller export (a defrost fault at about 6.5 °C from minute 2 to 7).
4. Open http://localhost:5173.

## Run

| When | Who (MetaMask account) | Do | Say |
| --- | --- | --- | --- |
| 0:00 | — | Landing page; let the animation run once | Evidence is scattered across five firms, so disputes take weeks. |
| 0:40 | Merlion Fresh Supplies | **New batches**: salmon ≤ 4 °C, **2 min** grace, for Tiong Bahru Grocers; cheese ≤ 8 °C, **10 min** grace, for Marina Bay Dining. Cold-room sensor: *Demo simulation: compliant sensor registration* → **Create batches** | Each batch's limits are fixed on-chain. The supplier's own cold-room sensor holds below the tightest limit (try a frozen batch: it holds below that limit too). |
| 1:30 | Merlion Fresh Supplies | **Log temperature** 2.8 °C on the salmon → **Check & hand over to Cargo** for each batch (2.9 °C) | Signing off records the moment it leaves the supplier. |
| 2:00 | Equator Air Cargo | **Open a container**: sea, *MSC AURORA 041E*, Melbourne → Singapore; number left blank. Sensor: *Register your sensor for this supply*, id `RCU-88213`, attach `reefer-excursion.csv` → **Open container** | The container number is generated in ISO 6346 form. Cargo's own reefer sensor: its export stands in for the live feed, from now. |
| 2:40 | Equator Air Cargo | **Inspect & receive into container** for each batch (within 2 minutes of the supplier's sign-off) | Receiving straight into the container is each batch's entry time. |
| 3:00 | Equator Air Cargo | **Report issue**: refrigeration failure, 5 min, "defrost fault mid-voyage". Talk through the dashboards while the voyage runs: wait until about 8 minutes after opening the container | The export's defrost fault runs from minute 2 to 7. |
| 9:00 | Equator Air Cargo | **Check & hand over to Destination Freight Handler**: seal `SGB4471203`, 5.2 °C → **Seal, sign check & hand over** | Cargo seals after loading; the seal number is fixed from here and printed on the certificate. |
| 9:20 | Runway Cargo Handlers | **Inspect & accept**: 6.8 °C. Point at the red preview: *"This will flag Batch #1…"*, and the cheese within its 8 °C → sign | The handler registers no sensor: the container's own keeps reading. |
| 9:40 | Tiong Bahru Grocers QA | Dashboard: the flagged stage is already there, **mid-journey**. Open it: too warm on receipt, and Cargo's own sensor above 4 °C for about 6 minutes → **Upheld** + note | QA sees problems the moment they happen, from the holder's own data. |
| 10:20 | Runway → Merlion Fresh Cold Store | Handler **Check & hand over to Cold Store**. Wait 3 minutes, then the cold store **Inspect & accept** | That dock time is measured from the two signatures: over the salmon's 2-minute grace, inside the cheese's 10. |
| 13:30 | Merlion Fresh Cold Store | **Register your cold-room sensor** (demo compliant) → **Unload container** → **Check & hand over to Reefer Truck** for each batch | The container's job is done; batches go on singly. |
| 14:00 | Kallang Reefer Trucks | **Inspect & accept** each batch → the salmon's truck sensor: *Demo simulation: breached sensor registration*; the cheese's: compliant → after about 4 minutes, **Check & deliver to buyer** for each | The salmon's truck refrigeration fails a minute in and climbs past its limit. |
| 18:00 | Each buyer | **Inspect & accept delivery** (salmon 8.7 °C, *Accept with issues*; cheese 3.7 °C) | Every handover was two signatures; every stage had its holder's sensor. |
| 18:30 | Tiong Bahru Grocers | Open Batch #1: *"Problem first detected while with Cargo"*, the five handover checks, and the journey chart: each holder's readings, red excursions, amber dock gaps | The whole story on one page, in real time. |
| 19:00 | Tiong Bahru Grocers QA | Rule on the dock-time claim (**Verify readings on-chain** → *Compensation agreed*) and the truck claim (*Upheld*) → **Ready for your final decision** → **Reject** with a reason | QA's two jobs: who's responsible, and whether it's sellable. |
| 19:40 | Tiong Bahru Grocers | **Acknowledge receipt** → **Printable certificate**. Open its QR link: the public verification page and the batch's full transaction history, no sign-in | No money moved; the firms settle between themselves. |
| 20:00 | Marina Bay Dining / Admin | The cheese's page: all five checks passed. Admin: **Overview** and **Audit log** | Same journey, different limits, different verdict, all on-chain. |

To shorten it, skip the waits: the salmon is still flagged on receipt at the handler and on delivery, and the cheese stays clean.

## If something goes wrong

- **"Nonce too high" in MetaMask:** clear that account's activity data (see above).
- **A dashboard looks stale:** it refreshes every few seconds on its own, or reload the page.
- **"Sensor readings being verified":** a stage's readings are committed and summarised a few seconds after the receiver signs in.
- **"Register a sensor first":** the holder hasn't registered its sensor for this stage yet; it's the first action on the shipment's card.
- **A stage was flagged for its handover gap unexpectedly:** the receiver signed in more than the batch's grace period after the sender signed off.
- **The salmon's stage 1 isn't flagged by the sensor:** Cargo signed the container off before the export's fault (minutes 2 to 7 after registering the sensor) had run longer than the grace period.
- **No "final decision" option for QA:** the certificate needs all five stages (handover plus verified readings), and every flagged stage must have a ruling.
- **Showing tamper detection:** change a reading in `gateway.commits` in Postgres; the batch page's **Verify readings on-chain** then reports that the stored readings don't match the sensor's commit.
