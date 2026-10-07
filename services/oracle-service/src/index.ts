// Oracle Service. Custodians upload the logger file for the leg they held; the service hashes it,
// checks it against the sensor's own commit, and submits per-batch summaries to SensorOracle.
// It also plays the (simulated) sensor, which commits what it recorded when each leg ends.
import {
  type AuthedRequest,
  HttpError,
  createApp,
  db,
  env,
  migrate,
  requireAuth,
  requireRole,
  serviceSigner,
  start,
  contract,
  z,
} from "@coldchainsg/common";
import { ZeroAddress, ZeroHash, decodeBytes32String, encodeBytes32String } from "ethers";
import {
  STATUS,
  batchesFor,
  custody,
  legsOf,
  rawFile,
  recordingFor,
  sensorOracle,
  startSensorLoop,
  submitUpload,
} from "./evidence.ts";
import { DEMO_FILES, type DemoFile, RECORDINGS, type Recording } from "./replay.ts";
import { schemaSql } from "./schema.ts";

await migrate(schemaSql);

const app = createApp();
const asAdmin = () => contract("SensorOracle", serviceSigner(env.ADMIN_PRIVATE_KEY, "Admin"));

const idSchema = z.coerce.number().int().positive();
const legSchema = z.coerce.number().int().min(1).max(4);
const MAX_FILE_BYTES = 200_000;

// ---- Sensors -------------------------------------------------------------------

app.get("/sensors", requireAuth, async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM oracle.sensors ORDER BY registered_at");
  res.json(rows);
});

/** Registers a simulated sensor. Every demo sensor reports through the one simulated device key. */
app.post("/sensors", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { sensorId, label } = z
    .object({
      sensorId: z.string().trim().min(1).max(31), // must fit in bytes32
      label: z.string().trim().min(1).max(120),
    })
    .parse(req.body);

  const device = await serviceSigner(env.SENSOR_PRIVATE_KEY, "Sensor").getAddress();
  const tx = await asAdmin().registerSensor(encodeBytes32String(sensorId), device);
  await tx.wait();
  await db.query("INSERT INTO oracle.sensors (sensor_id, device, label, tx_hash) VALUES ($1, $2, $3, $4)", [
    sensorId,
    device,
    label,
    tx.hash,
  ]);
  res.status(201).json({ sensorId, device, txHash: tx.hash });
});

// ---- Legs: status, the sensor's recording, and custodian uploads -------------------------

/** The leg a request refers to, normalised to the unit it's recorded on. */
async function resolveLeg(shipmentId: number, leg: number) {
  const window = await custody().legWindow(shipmentId, leg);
  const recordedOn = Number(window.recordedOn);
  return {
    recordedOn,
    custodian: window.custodian === ZeroAddress ? null : (window.custodian as string),
    start: Number(window.start),
    end: Number(window.end),
    sensorId: decodeBytes32String(window.sensorId),
    committedHash: (await sensorOracle().committedHash(recordedOn, leg)) as string,
  };
}

async function legStatus(shipmentId: number, leg: number) {
  const l = await resolveLeg(shipmentId, leg);
  const evidence = [];
  for (const batchId of await batchesFor(l.recordedOn, leg)) {
    evidence.push({ batchId, status: STATUS[Number((await sensorOracle().getSummary(batchId, leg)).status)] });
  }
  const committed = l.committedHash !== ZeroHash;
  return {
    shipmentId: l.recordedOn,
    leg,
    custodian: l.custodian,
    start: l.start || null,
    end: l.end || null,
    sensorId: l.sensorId,
    recording: await recordingFor(l.recordedOn, leg),
    sensorCommitted: committed,
    evidence,
    // Upload is possible once the leg has ended and the sensor has committed, until every batch is verified.
    awaitingUpload: !!l.end && committed && evidence.some((e) => e.status !== "Verified"),
  };
}

/**
 * Admins see every leg, including ones not started yet (so the demo can set what the sensor will
 * record before the leg ends). Everyone else sees the legs they held, i.e. the logs they owe.
 */
app.get("/legs", requireAuth, async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  const c = custody();
  const nextId = Number(await c.nextId());
  const legs = [];
  for (let id = 1; id < nextId; id++) {
    const unit = await c.getUnit(id);
    for (const leg of legsOf(Number(unit.kind))) {
      const window = await c.legWindow(id, leg);
      if (role !== "ADMIN" && window.custodian !== wallet) continue;
      legs.push(await legStatus(id, leg));
    }
  }
  res.json(legs);
});

/** Demo control: what the sensor records on a leg. Can only change until the sensor commits. */
app.put("/legs/:shipmentId/:leg/recording", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const leg = legSchema.parse(req.params.leg);
  const { recording } = z.object({ recording: z.enum(Object.keys(RECORDINGS) as [Recording, ...Recording[]]) }).parse(req.body);
  const l = await resolveLeg(idSchema.parse(req.params.shipmentId), leg);
  if (l.committedHash !== ZeroHash) throw new HttpError(409, "The sensor has already recorded this leg");

  await db.query(
    `INSERT INTO oracle.leg_recordings (shipment_id, leg, recording) VALUES ($1, $2, $3)
     ON CONFLICT (shipment_id, leg) DO UPDATE SET recording = $3`,
    [l.recordedOn, leg, recording],
  );
  res.json(await legStatus(l.recordedOn, leg));
});

app.get("/demo-files", requireAuth, (_req, res) => {
  res.json(Object.entries(DEMO_FILES).map(([id, f]) => ({ id, label: f.label, fileName: f.file })));
});

/**
 * The custodian who held a leg uploads its logger file: either a demo file by name, or the raw
 * bytes of a CSV as base64 (bytes, not text, so the hash is exactly the file's).
 */
app.post("/legs/:shipmentId/:leg/upload", requireAuth, async (req, res) => {
  const { wallet } = req as AuthedRequest;
  const leg = legSchema.parse(req.params.leg);
  const body = z
    .union([
      z.object({ demoFile: z.enum(Object.keys(DEMO_FILES) as [DemoFile, ...DemoFile[]]) }),
      z.object({ fileBase64: z.base64().max(Math.ceil(MAX_FILE_BYTES / 3) * 4), fileName: z.string().trim().min(1).max(120) }),
    ])
    .parse(req.body);

  const l = await resolveLeg(idSchema.parse(req.params.shipmentId), leg);
  if (!l.custodian || l.custodian !== wallet) {
    throw new HttpError(403, "Only the custodian who held this leg can upload its sensor log");
  }
  if (!l.end) throw new HttpError(409, "This leg is still in progress. Upload the log after you've handed over.");
  if (l.committedHash === ZeroHash) {
    throw new HttpError(409, "The sensor hasn't reported this leg yet. Try again in a few seconds.");
  }
  const { awaitingUpload } = await legStatus(l.recordedOn, leg);
  if (!awaitingUpload) throw new HttpError(409, "This leg's evidence is already verified");

  const file =
    "demoFile" in body ? rawFile(DEMO_FILES[body.demoFile].file) : Buffer.from(body.fileBase64, "base64");
  const fileName = "demoFile" in body ? DEMO_FILES[body.demoFile].file : body.fileName;

  let result;
  try {
    result = await submitUpload({
      shipmentId: l.recordedOn,
      leg,
      file,
      fileName,
      uploadedBy: wallet,
      legStart: l.start,
      committedHash: l.committedHash,
    });
  } catch (err) {
    if ((err as Error).message?.match(/CSV/)) throw new HttpError(400, (err as Error).message);
    throw err;
  }
  res.status(201).json({ shipmentId: l.recordedOn, leg, ...result });
});

// ---- Evidence views ------------------------------------------------------------------

/** On-chain evidence for every leg of a batch, plus the latest uploaded readings for charts. */
app.get("/evidence/:batchId", requireAuth, async (req, res) => {
  const batchId = idSchema.parse(req.params.batchId);
  const unit = await custody().getUnit(batchId);
  if (Number(unit.kind) !== 2) throw new HttpError(404, "No such batch");

  const legs = [];
  for (const leg of [1, 2, 3, 4]) {
    const l = await resolveLeg(batchId, leg);
    const s = await sensorOracle().getSummary(batchId, leg);
    const upload = await db.query(
      `SELECT id, file_name, uploaded_by, created_at, readings FROM oracle.leg_uploads
       WHERE shipment_id = $1 AND leg = $2 ORDER BY id DESC LIMIT 1`,
      [l.recordedOn, leg],
    );
    const u = upload.rows[0];
    legs.push({
      leg,
      custodian: l.custodian,
      start: l.start || null,
      end: l.end || null,
      sensorId: l.sensorId,
      committedHash: l.committedHash === ZeroHash ? null : l.committedHash,
      summary:
        Number(s.status) === 0
          ? null
          : {
              status: STATUS[Number(s.status)],
              fileHash: s.fileHash,
              minC: Number(s.minTenthsC) / 10,
              maxC: Number(s.maxTenthsC) / 10,
              breachMinutes: Number(s.breachMinutes),
              breachStart: Number(s.breachStart) || null,
              breachEnd: Number(s.breachEnd) || null,
              submittedAt: Number(s.submittedAt),
            },
      latestUpload: u
        ? { id: u.id, fileName: u.file_name, uploadedBy: u.uploaded_by, uploadedAt: u.created_at, readings: u.readings }
        : null,
    });
  }
  res.json({ batchId, thresholdC: Number(unit.thresholdTenthsC) / 10, graceMinutes: Number(unit.graceMinutes), legs });
});

/** The exact uploaded file, so anyone can re-hash it and call verifyFileHash on-chain. */
app.get("/uploads/:id/raw", requireAuth, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { rows } = await db.query("SELECT file_name, raw_file FROM oracle.leg_uploads WHERE id = $1", [id]);
  if (!rows[0]) throw new HttpError(404, "No such upload");
  res.type("text/csv").attachment(rows[0].file_name).send(rows[0].raw_file);
});

startSensorLoop();
start(app, "oracle-service", env.ORACLE_PORT);
