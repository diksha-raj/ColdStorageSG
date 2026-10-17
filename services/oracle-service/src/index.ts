// Oracle Service. Once a sensor has committed its readings for a stage window (via the sensor
// gateway), the oracle fetches those readings, summarises them for each batch against the batch's
// own limit (each batch's own entry and exit, inside a container's window), and submits the
// summary to SensorOracle with the hash of the file it used. A different hash means the readings
// were altered after the sensor reported, and the contract marks the stage EvidenceMismatch.
//
// It also serves each batch's evidence: per stage, the sensor, the readings, the summary and the
// handover gap after it. That view is public, like the certificate it backs.
import { HttpError, contract, createApp, db, env, migrate, requireAuth, requireRole, serviceSigner, start, z } from "@coldchainsg/common";
import { ZeroAddress, ZeroHash, decodeBytes32String } from "ethers";
import { schemaSql } from "./schema.ts";
import { type Reading, parseCsv, sha256, summarize } from "./summary.ts";

await migrate(schemaSql);

const app = createApp();
const custody = () => contract("ShipmentCustody");
const sensorOracle = () => contract("SensorOracle");
const asOracle = () => contract("SensorOracle", serviceSigner(env.ORACLE_PRIVATE_KEY, "Oracle"));
const GATEWAY = `http://localhost:${env.GATEWAY_PORT}`;

const STAGES = [0, 1, 2, 3, 4];
const STATUS = ["None", "Verified", "EvidenceMismatch"] as const;
const idSchema = z.coerce.number().int().positive();

async function gateway(path: string) {
  const res = await fetch(GATEWAY + path);
  return res.ok ? res.json() : null;
}

// ---- Summarising -------------------------------------------------------------------------

type Submitted = { batchId: number; stage: number; status: string };
let queue: Promise<unknown> = Promise.resolve();

/** Runs a pass after any pass already in progress (passes never overlap). */
function summariseOnce(): Promise<Submitted[]> {
  const pass = queue.then(runPass);
  queue = pass.catch(() => undefined);
  return pass;
}

async function runPass(): Promise<Submitted[]> {
  const c = custody();
  const out: Submitted[] = [];
  const nextId = Number(await c.nextId());
  for (let batchId = 1; batchId < nextId; batchId++) {
    const batch = await c.getUnit(batchId);
    if (Number(batch.kind) !== 2) continue;
    for (const stage of STAGES) {
      const summary = await sensorOracle().getSummary(batchId, stage);
      if (STATUS[Number(summary.status)] === "Verified") continue;
      const unit = Number(await c.recordedOn(batchId, stage));
      if (unit === 0 || (await sensorOracle().committedHash(unit, stage)) === ZeroHash) continue;

      const log = await gateway(`/logs/${unit}/${stage}`);
      if (!log) continue;
      const fileHash = sha256(log.csv);
      // Already reported this exact file as a mismatch: wait for different readings.
      if (STATUS[Number(summary.status)] === "EvidenceMismatch" && summary.fileHash === fileHash) continue;

      const w = await c.stageWindow(batchId, stage);
      const thresholdC = Number(batch.thresholdTenthsC) / 10;
      const s = summarize(parseCsv(log.csv), thresholdC, Number(w.start), Number(w.end));
      const tx = await asOracle().submitLegSummary(
        batchId,
        stage,
        fileHash,
        Math.round(s.minC * 10),
        Math.round(s.maxC * 10),
        s.breachMinutes,
        s.missingMinutes,
        s.breachStart,
        s.breachEnd,
      );
      await tx.wait();
      const status = STATUS[Number((await sensorOracle().getSummary(batchId, stage)).status)];
      await db.query(
        `INSERT INTO oracle.submissions (batch_id, stage, file_hash, status, threshold_c, max_c, breach_minutes, missing_minutes, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [batchId, stage, fileHash, status, thresholdC, s.maxC, s.breachMinutes, s.missingMinutes, tx.hash],
      );
      out.push({ batchId, stage, status });
    }
  }
  return out;
}

function startLoop(intervalMs = 3000) {
  const tick = async () => {
    try {
      for (const s of await summariseOnce()) console.log(`summary: batch ${s.batchId} stage ${s.stage} ${s.status}`);
    } catch (err) {
      console.error("summary pass failed:", (err as Error).message);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

/** Runs a pass now instead of waiting for the next tick (handy in the demo and tests). */
app.post("/sync", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  res.json({ submitted: await summariseOnce() });
});

// ---- Evidence view ---------------------------------------------------------------------------

/**
 * Per stage: who held the batch, entry and exit, the sensor that covered it, its readings for the
 * batch's window (live while the stage is in progress), the on-chain summary, and the handover
 * gap that followed. Public: the readings back a certificate anyone may verify.
 */
app.get("/evidence/:batchId", async (req, res) => {
  const batchId = idSchema.parse(req.params.batchId);
  const c = custody();
  if (batchId >= Number(await c.nextId())) throw new HttpError(404, "No such batch");
  const batch = await c.getUnit(batchId);
  if (Number(batch.kind) !== 2) throw new HttpError(404, "No such batch");

  const stages = [];
  for (const stage of STAGES) {
    const w = await c.stageWindow(batchId, stage);
    const unit = Number(w.unit);
    const start = Number(w.start);
    const end = Number(w.end);
    const onChain = unit === 0 ? null : await c.getSensor(batchId, stage);
    const sensorId = onChain && onChain.device !== ZeroAddress ? decodeBytes32String(onChain.sensorId) : null;
    const sensor = sensorId
      ? ((await gateway(`/sensors/${sensorId}`)) ?? { sensorId, owner: onChain!.owner, mode: null, label: "External sensor" })
      : null;

    // Readings: the committed file once the window has closed, else the live feed so far.
    let readings: Reading[] = [];
    let committed = null;
    if (unit !== 0 && start !== 0) {
      const log = await gateway(`/logs/${unit}/${stage}`);
      if (log) {
        const onChainHash = await sensorOracle().committedHash(unit, stage);
        committed = { fileHash: log.fileHash, txHash: log.txHash, matchesChain: sha256(log.csv) === onChainHash };
        readings = parseCsv(log.csv);
      } else if (sensor) {
        readings = (await gateway(`/live/${unit}/${stage}`))?.readings ?? [];
      }
      readings = readings.filter((r) => r.at >= start && (end === 0 || r.at <= end));
    }

    const s = await sensorOracle().getSummary(batchId, stage);
    const cp = unit === 0 ? null : await c.getCheckpoint(unit, stage);
    // The handover closing this stage: sign-off to sign-in, unrefrigerated. None after stage 1.
    const gap =
      cp && Number(cp.incoming.checkedAt) !== 0 && stage !== 1
        ? { from: Number(cp.outgoing.checkedAt), to: Number(cp.incoming.checkedAt), minutes: Number(await c.handoverGapMinutes(batchId, stage)) }
        : null;

    stages.push({
      stage,
      custodian: w.custodian === ZeroAddress ? null : w.custodian,
      recordedOn: unit || null,
      start: start || null,
      end: end || null,
      sensor,
      committed,
      summary:
        Number(s.status) === 0
          ? null
          : {
              status: STATUS[Number(s.status)],
              fileHash: s.fileHash,
              minC: Number(s.minTenthsC) / 10,
              maxC: Number(s.maxTenthsC) / 10,
              breachMinutes: Number(s.breachMinutes),
              missingMinutes: Number(s.missingMinutes),
              breachStart: Number(s.breachStart) || null,
              breachEnd: Number(s.breachEnd) || null,
            },
      readings,
      gap,
    });
  }

  res.json({
    batchId,
    thresholdC: Number(batch.thresholdTenthsC) / 10,
    graceMinutes: Number(batch.graceMinutes),
    stages,
  });
});

startLoop();
start(app, "oracle-service", env.ORACLE_PORT);
