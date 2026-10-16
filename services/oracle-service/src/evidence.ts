// How sensor evidence reaches the chain:
//   1. When a leg ends (the next custodian accepts), the simulated sensor automatically commits
//      the SHA-256 of what it recorded. That's the truth an upload is checked against.
//   2. The custodian who held the leg uploads their logger file. The oracle hashes it, summarises
//      it per batch, and submits on-chain. A file that doesn't match the sensor's commit is
//      recorded as EvidenceMismatch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contract, db, env, repoRoot, serviceSigner } from "@coldchainsg/common";
import { ZeroAddress, ZeroHash } from "ethers";
import { RECORDINGS, type Recording, parseAndRebase, sha256, summarize } from "./replay.ts";

export const STATUS = ["None", "Verified", "EvidenceMismatch"] as const;
export const rawFile = (name: string) => readFileSync(join(repoRoot, "data", "raw", name));

export const custody = () => contract("ShipmentCustody");
export const sensorOracle = () => contract("SensorOracle");
const asOracle = () => contract("SensorOracle", serviceSigner(env.ORACLE_PRIVATE_KEY, "Oracle"));
const asSensor = () => contract("SensorOracle", serviceSigner(env.SENSOR_PRIVATE_KEY, "Sensor"));

/** Legs recorded on a unit: a container carries legs 1-3, a batch carries leg 4. */
export const legsOf = (kind: number) => (kind === 1 ? [1, 2, 3] : kind === 2 ? [4] : []);

/** Batches judged by a leg's file: all of the container's batches for legs 1-3, else the batch itself. */
export async function batchesFor(shipmentId: number, leg: number): Promise<number[]> {
  return leg <= 3 ? (await custody().getBatches(shipmentId)).map(Number) : [shipmentId];
}

export async function recordingFor(shipmentId: number, leg: number): Promise<Recording> {
  const { rows } = await db.query("SELECT recording FROM oracle.leg_recordings WHERE shipment_id = $1 AND leg = $2", [
    shipmentId,
    leg,
  ]);
  return rows[0]?.recording ?? "compliant";
}

// ---- 1. Sensor auto-commit --------------------------------------------------------

const failedLegs = new Set<string>(); // logged once each, so a broken shipment doesn't flood the log

/**
 * Commits the sensor's file hash for every leg that has ended but not yet been committed.
 * A leg that can't be committed (e.g. its sensor was never registered) is skipped, so one
 * bad shipment never holds up everyone else's evidence.
 */
export async function commitEndedLegs() {
  const c = custody();
  const nextId = Number(await c.nextId());
  for (let id = 1; id < nextId; id++) {
    const unit = await c.getUnit(id);
    for (const leg of legsOf(Number(unit.kind))) {
      const window = await c.legWindow(id, leg);
      if (Number(window.end) === 0 || window.custodian === ZeroAddress) continue;
      if ((await sensorOracle().committedHash(id, leg)) !== ZeroHash) continue;

      try {
        const hash = sha256(rawFile(RECORDINGS[await recordingFor(id, leg)]));
        await (await asSensor().commitFileHash(id, leg, hash)).wait();
        console.log(`sensor: committed shipment ${id} leg ${leg}`);
      } catch (err) {
        const key = `${id}:${leg}`;
        if (!failedLegs.has(key)) {
          failedLegs.add(key);
          console.error(`sensor: can't commit shipment ${id} leg ${leg}: ${(err as any).reason ?? (err as Error).message}`);
        }
      }
    }
  }
}

/**
 * Checks logs that custodians uploaded at handover, once their leg has ended and the sensor has
 * committed. Each one is submitted exactly like an upload made after the handover.
 */
export async function processStagedUploads() {
  const { rows } = await db.query("SELECT * FROM oracle.staged_uploads ORDER BY created_at");
  for (const row of rows) {
    const window = await custody().legWindow(row.shipment_id, row.leg);
    const committedHash: string = await sensorOracle().committedHash(row.shipment_id, row.leg);
    if (Number(window.end) === 0 || committedHash === ZeroHash) continue; // leg still open, or sensor not reported yet

    const statuses = await Promise.all(
      (await batchesFor(row.shipment_id, row.leg)).map(async (b) => STATUS[Number((await sensorOracle().getSummary(b, row.leg)).status)]),
    );
    if (statuses.some((st) => st !== "Verified")) {
      const result = await submitUpload({
        shipmentId: row.shipment_id,
        leg: row.leg,
        file: row.raw_file,
        fileName: row.file_name,
        uploadedBy: row.uploaded_by,
        legStart: Number(window.start),
        committedHash,
      });
      console.log(`oracle: checked handover log for shipment ${row.shipment_id} leg ${row.leg}: ${result.matches ? "matches" : "MISMATCH"}`);
    }
    await db.query("DELETE FROM oracle.staged_uploads WHERE shipment_id = $1 AND leg = $2", [row.shipment_id, row.leg]);
  }
}

export function startSensorLoop(intervalMs = 3000) {
  const tick = async () => {
    try {
      await commitEndedLegs();
      await processStagedUploads();
    } catch (err) {
      console.error("sensor commit failed:", (err as any).reason ?? (err as Error).message);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

// ---- 2. Custodian upload ------------------------------------------------------------

export async function submitUpload(args: {
  shipmentId: number; // the unit the leg is recorded on
  leg: number;
  file: Buffer;
  fileName: string;
  uploadedBy: string;
  legStart: number;
  committedHash: string;
}) {
  const fileHash = sha256(args.file);
  const readings = parseAndRebase(args.file.toString("utf8"), args.legStart);

  const { rows } = await db.query(
    `INSERT INTO oracle.leg_uploads (shipment_id, leg, uploaded_by, file_name, raw_file, file_hash, committed_hash, readings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [args.shipmentId, args.leg, args.uploadedBy, args.fileName, args.file, fileHash, args.committedHash, JSON.stringify(readings)],
  );
  const uploadId = rows[0].id;

  // One summary per batch, each against that batch's own threshold.
  const results = [];
  for (const batchId of await batchesFor(args.shipmentId, args.leg)) {
    const batch = await custody().getUnit(batchId);
    const thresholdC = Number(batch.thresholdTenthsC) / 10;
    const stats = summarize(readings, thresholdC);

    let status: string;
    let txHash: string | null = null;
    if (STATUS[Number((await sensorOracle().getSummary(batchId, args.leg)).status)] === "Verified") {
      status = "AlreadyVerified"; // accepted evidence can't be replaced
    } else {
      const tx = await asOracle().submitLegSummary(
        batchId,
        args.leg,
        fileHash,
        Math.round(stats.minC * 10),
        Math.round(stats.maxC * 10),
        stats.breachMinutes,
        stats.breachStart,
        stats.breachEnd,
      );
      await tx.wait();
      txHash = tx.hash;
      status = STATUS[Number((await sensorOracle().getSummary(batchId, args.leg)).status)];
    }

    await db.query(
      `INSERT INTO oracle.upload_results (upload_id, batch_id, status, threshold_c, min_c, max_c, breach_minutes, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uploadId, batchId, status, thresholdC, stats.minC, stats.maxC, stats.breachMinutes, txHash],
    );
    results.push({ batchId, status, thresholdC, ...stats, txHash });
  }

  return { uploadId, fileHash, committedHash: args.committedHash, matches: fileHash === args.committedHash, results };
}
