// Sensor Gateway. Stands in for the sensor vendor's platform: each party's sensor reports here,
// and the gateway signs each sensor's readings with that sensor's own device key.
//
//   POST /sensors     a participant registers a sensor: their own (with its export attached) or a
//                     demo sensor that reads compliant or breached. The gateway creates the
//                     device key and returns its address; the participant then registers
//                     (sensorId, device) on-chain against their shipment, from MetaMask.
//   commit loop       once a stage's window closes on-chain (the receiver signs in), the sensor
//                     commits the SHA-256 of its readings for that window, signed by its device key.
//   GET /logs/...     the committed readings file, public, so anyone can re-hash it.
//   GET /live/...     readings so far for a window still in progress.
//
// The gateway never decides pass or fail: the oracle summarises, the contracts flag.
import {
  type AuthedRequest,
  HttpError,
  TxSigner,
  contract,
  createApp,
  db,
  env,
  migrate,
  provider,
  requireAuth,
  requireRole,
  serviceSigner,
  start,
  z,
} from "@coldchainsg/common";
import { Wallet, ZeroAddress, ZeroHash, concat, decodeBytes32String, encodeBytes32String, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { schemaSql } from "./schema.ts";
import { DEFAULT_PROFILE, type Mode, type Profile, type SimSensor, parseFeed, readingsBetween, sha256, toCsv } from "./simulate.ts";

await migrate(schemaSql);

const app = createApp();
const custody = () => contract("ShipmentCustody");
const sensorOracle = () => contract("SensorOracle");
const gateway = () => serviceSigner(env.SENSOR_PRIVATE_KEY, "Sensor gateway");

// Who registers which sensor, by role: supplier's cold room, Cargo's container, the cold store's
// room, the truck. The destination freight handler uses the container's sensor.
const OWNER_ROLES = ["SUPPLIER", "CARRIER", "COLD_STORE", "TRUCK"] as const;
const PREFIX: Record<string, string> = { SUPPLIER: "SUP", CARRIER: "CTR", COLD_STORE: "COLD", TRUCK: "TRUCK" };

/** Now, on the chain's clock (custody windows are block timestamps, which can run ahead of ours). */
const chainNow = async () => Math.max(Math.floor(Date.now() / 1000), (await provider.getBlock("latest"))!.timestamp);

/** Each sensor's own device key, derived from the gateway's key and the sensor id. */
const deviceKey = (sensorId: string) => keccak256(concat([env.SENSOR_PRIVATE_KEY!, toUtf8Bytes(sensorId)]));
const devices = new Map<string, TxSigner>();
const deviceSigner = (sensorId: string) => {
  let s = devices.get(sensorId);
  if (!s) devices.set(sensorId, (s = new TxSigner(new Wallet(deviceKey(sensorId), provider))));
  return s;
};

/**
 * What the batches this sensor covers need: every unit it's registered for on-chain, a container's
 * batches included. A simulated unit is set below the tightest limit, and a failure climbs past the
 * loosest. Worked out when readings are produced, so a container sealed with all its batches
 * commits readings set for all of them.
 */
async function profileFor(sensorId: string): Promise<Profile> {
  const c = custody();
  const events = await c.queryFilter(c.filters.SensorRegistered(null, null, encodeBytes32String(sensorId)), 0);
  const ids = [...new Set(events.map((e: any) => Number(e.args.id)))];
  const limits: number[] = [];
  for (const id of ids) {
    const u = await c.getUnit(id);
    const batches = Number(u.kind) === 1 ? ((await c.getBatches(id)) as bigint[]).map(Number) : [id];
    for (const b of batches) limits.push(Number((await c.getUnit(b)).thresholdTenthsC) / 10);
  }
  return limits.length ? { lowestLimitC: Math.min(...limits), highestLimitC: Math.max(...limits) } : DEFAULT_PROFILE;
}

const toSim = (row: any): SimSensor => ({ sensorId: row.sensor_id, mode: row.mode, registeredAt: Number(row.registered_at), feed: row.feed });
const view = (row: any) => ({ sensorId: row.sensor_id, owner: row.owner, mode: row.mode as Mode, label: row.label, device: row.device, registeredAt: Number(row.registered_at) });

async function sensorRow(sensorId: string) {
  return (await db.query("SELECT * FROM gateway.sensors WHERE sensor_id = $1", [sensorId])).rows[0] ?? null;
}

// ---- Registering a sensor ---------------------------------------------------------------

app.post("/sensors", requireAuth, requireRole(...OWNER_ROLES), async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  const body = z
    .object({
      mode: z.enum(["compliant", "breached", "feed"]),
      sensorId: z.string().trim().regex(/^[A-Za-z0-9-]{3,31}$/, "Sensor ids are 3-31 letters, digits or dashes").optional(),
      label: z.string().trim().max(80).optional(),
      feedCsv: z.string().max(2_000_000).optional(),
    })
    .parse(req.body);

  let sensorId: string;
  let feed: (number | null)[] | null = null;
  if (body.mode === "feed") {
    if (!body.sensorId) throw new HttpError(400, "Enter your sensor's id");
    if (!body.feedCsv) throw new HttpError(400, "Attach your sensor's export (timestamp,temperature_c)");
    try {
      feed = parseFeed(body.feedCsv);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    sensorId = body.sensorId.toUpperCase();
    const existing = await sensorRow(sensorId);
    if (existing && existing.owner !== wallet) throw new HttpError(409, "That sensor is registered to another participant");
    if (existing) {
      res.json(view(existing));
      return;
    }
  } else {
    // A demo sensor: a new id each time, e.g. SIM-COLD-3F2A.
    sensorId = `SIM-${PREFIX[role!]}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
  }

  const device = deviceSigner(sensorId);
  const deviceAddress = await device.getAddress();
  // The device pays for its own commits; the gateway tops it up.
  await (await gateway().sendTransaction({ to: deviceAddress, value: parseEther("0.05") })).wait();

  const label = body.label || (body.mode === "feed" ? `Sensor ${sensorId}` : `Demo sensor (${body.mode})`);
  const registeredAt = await chainNow();
  const { rows } = await db.query(
    `INSERT INTO gateway.sensors (sensor_id, owner, mode, label, device, feed, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [sensorId, wallet, body.mode, label, deviceAddress, feed ? JSON.stringify(feed) : null, registeredAt],
  );
  res.status(201).json(view(rows[0]));
});

/** The caller's sensors, so a room or truck can be reused for the next shipment. */
app.get("/sensors/mine", requireAuth, async (req, res) => {
  const { wallet } = req as AuthedRequest;
  const { rows } = await db.query("SELECT * FROM gateway.sensors WHERE owner = $1 ORDER BY created_at DESC", [wallet]);
  res.json(rows.map(view));
});

/** Public facts about one sensor (how it reads, who owns it). */
app.get("/sensors/:sensorId", async (req, res) => {
  const row = await sensorRow(req.params.sensorId);
  if (!row) throw new HttpError(404, "Unknown sensor");
  res.json(view(row));
});

// ---- Readings ---------------------------------------------------------------------------------

const unitStage = (req: any) => ({
  unitId: z.coerce.number().int().positive().parse(req.params.unitId),
  stage: z.coerce.number().int().min(0).max(4).parse(req.params.stage),
});

/** The readings file the sensor committed for a closed window. Public: anyone can re-hash it. */
app.get("/logs/:unitId/:stage", async (req, res) => {
  const { unitId, stage } = unitStage(req);
  const { rows } = await db.query("SELECT * FROM gateway.commits WHERE unit_id = $1 AND stage = $2", [unitId, stage]);
  const c = rows[0];
  if (!c) throw new HttpError(404, "The sensor hasn't committed this window yet");
  res.json({
    unitId,
    stage,
    sensorId: c.sensor_id,
    start: Number(c.start_at),
    end: Number(c.end_at),
    fileHash: c.file_hash,
    txHash: c.tx_hash,
    csv: c.csv,
  });
});

/** Readings so far for a window still in progress (the live feed). */
app.get("/live/:unitId/:stage", async (req, res) => {
  const { unitId, stage } = unitStage(req);
  const w = await custody().sensorWindow(unitId, stage);
  if (w.sensor.device === ZeroAddress) throw new HttpError(404, "No sensor is registered for this stage");
  const row = await sensorRow(decodeBytes32String(w.sensor.sensorId));
  if (!row) throw new HttpError(404, "This sensor doesn't report through this gateway");
  const end = Number(w.end) || (await chainNow());
  const readings = readingsBetween(toSim(row), Number(w.start), end, await profileFor(row.sensor_id));
  res.json({ sensorId: row.sensor_id, start: Number(w.start), end, closed: Number(w.end) !== 0, readings });
});

// ---- Commit loop -----------------------------------------------------------------------------

const failed = new Set<string>(); // a failing window is retried every pass, but logged once
const STAGES_OF = (kind: number) => (kind === 1 ? [1, 2] : kind === 2 ? [0, 3, 4] : []);

/** Commits the readings for every window that has closed since the last pass. */
async function commitClosedWindows() {
  const c = custody();
  const done = new Set((await db.query("SELECT unit_id, stage FROM gateway.commits")).rows.map((r) => `${r.unit_id}:${r.stage}`));
  const nextId = Number(await c.nextId());
  for (let id = 1; id < nextId; id++) {
    const kind = Number((await c.getUnit(id)).kind);
    for (const stage of STAGES_OF(kind)) {
      const key = `${id}:${stage}`;
      if (done.has(key)) continue;
      try {
        const w = await c.sensorWindow(id, stage);
        if (w.sensor.device === ZeroAddress || Number(w.end) === 0) continue;
        if ((await sensorOracle().committedHash(id, stage)) !== ZeroHash) continue;
        const row = await sensorRow(decodeBytes32String(w.sensor.sensorId));
        if (!row) continue; // not one of ours

        const csv = toCsv(readingsBetween(toSim(row), Number(w.start), Number(w.end), await profileFor(row.sensor_id)));
        const fileHash = sha256(csv);
        const tx = await contract("SensorOracle", deviceSigner(row.sensor_id)).commitFileHash(id, stage, fileHash);
        await tx.wait();
        await db.query(
          `INSERT INTO gateway.commits (unit_id, stage, sensor_id, start_at, end_at, csv, file_hash, tx_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [id, stage, row.sensor_id, Number(w.start), Number(w.end), csv, fileHash, tx.hash],
        );
        console.log(`sensor ${row.sensor_id}: committed ${key} (${fileHash.slice(0, 10)}…)`);
      } catch (err) {
        if (!failed.has(key)) console.error(`commit ${key} failed:`, (err as Error).message);
        failed.add(key);
      }
    }
  }
}

function startCommitLoop(intervalMs = 2000) {
  const tick = async () => {
    try {
      await commitClosedWindows();
    } catch (err) {
      console.error("commit loop failed:", (err as Error).message);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

startCommitLoop();
start(app, "sensor-gateway", env.GATEWAY_PORT);
