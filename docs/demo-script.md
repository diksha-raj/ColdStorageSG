# 10-minute demo run sheet

The story: **a chilled salmon shipment warms up in transit. ColdChainSG shows where, who held it, and lets QA decide, without any firm having to chase anyone for evidence.**

## Before the session (about 5 minutes)

1. Start everything fresh:
   - `npm run chain`
   - `npm run deploy`
   - start the four services
   - `npm run seed`
   - `npm run web`
2. In MetaMask, import the keys that `npm run seed` printed. Connect each account to localhost:5173 the first time you use it. If the chain was restarted since you last imported them, clear each account's activity (Settings → Advanced → Clear activity tab data).
3. Open http://localhost:5173.

## Run (about 10 minutes)

| Time | Who (MetaMask account) | Do | Say |
| --- | --- | --- | --- |
| 0:00 | — | Landing page; let the animation run once | Evidence is scattered across five firms, so disputes take weeks. |
| 0:45 | Merlion Fresh Imports | **New container**: salmon (≤ 4 °C) for Tiong Bahru Grocers, cheese (≤ 8 °C) for Marina Bay Dining → **Create** | Each batch has its own buyer, QA inspector and limits, on-chain. |
| 1:30 | Admin | **Demo control**: set the container's **leg 2 to Breach** | Stands in for the real sensor, which we don't have. |
| 1:45 | Merlion Fresh Imports | **Log temperature** 2.8 °C → **Check & hand over to the air carrier**, dispatch 2.9 °C → sign | The sender's signed check: how it left. |
| 2:30 | Equator Air Cargo | **Inspect & accept** (3.0 °C). **Report issue**: refrigeration failure, 25 min, "reefer tripped during refuelling". **Check & hand over**, 5.2 °C | The carrier is honest about the problem; it's sealed into their signed check. |
| 3:30 | Runway Cargo Handlers | **Inspect & accept**: 7.1 °C, **Accept with issues**. Point at the red preview: *"This will flag Batch #2…"* → sign | The receiver records what they found. No rejection, no re-chilling: the stage is flagged permanently. |
| 4:15 | Tiong Bahru Grocers QA | Dashboard: the flagged stage is already there, **mid-journey**. Open it → both checks side by side → **Upheld** + note | QA sees problems the moment they happen, not weeks later. |
| 5:00 | Equator Air Cargo, Runway Cargo Handlers | **Sensor logs** card → upload *Compliant log* (carrier) and *Breached log* (handler) | The independent sensor cross-check. |
| 5:30 | Runway → Merlion Fresh Cold Store | Handler checks out; cold store inspects and accepts; **Split into batches**. Cold store uploads *Edited log* → **hash mismatch**, then *Compliant log* | An edited log is caught automatically. |
| 6:30 | Cold store → Kallang Reefer Trucks → each buyer | Check out each batch → truck inspects and accepts → checks out to buyer → each buyer **Inspect & accept delivery**. Truck uploads leg 4 logs. Admin **Sync now** | Every handover was a two-sided check. |
| 7:30 | Tiong Bahru Grocers | Open Batch #2: *"Problem first detected at Air carrier → Changi handler"*, the five-stage record, and the charts | The whole story on one page. |
| 8:00 | Tiong Bahru Grocers QA | Rule on the sensor claim (**Verify file on-chain** → *Compensation agreed*) → **Ready for your final decision** → **Reject** with a reason | QA's two jobs: who's responsible, and whether it's sellable. |
| 9:00 | Tiong Bahru Grocers | **Acknowledge receipt** → **Printable certificate** → *Print / Save as PDF* | The batch is closed, with a certificate anyone can verify against the chain. No money moved; the firms settle between themselves. |
| 9:30 | Admin | **Overview** (checks passed and failed, flags by stage and reason, QA decisions) and **Audit log** | Every step is in the on-chain record. |

## If something goes wrong

- **"Nonce too high" in MetaMask:** clear that account's activity data (see above).
- **A dashboard looks stale:** it refreshes every few seconds on its own, or reload the page.
- **"Waiting for the sensor…" on a log upload:** the sensor reports a few seconds after the handover.
- **Can't set a leg to Breach:** that leg has already ended. Set it right after creating the container.
- **No "final decision" option for QA:** the certificate needs all five stages (checkpoints plus sensor logs for legs 1–4), and every flagged stage must have a ruling.
