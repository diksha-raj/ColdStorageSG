// Custody Service. Users send custody transactions (create, receive into a container, seal,
// hand over, unload, register their sensor) from MetaMask; this service stores the off-chain
// details and serves read views that combine on-chain custody state with that metadata.
import {
  type AuthedRequest,
  HttpError,
  contract,
  createApp,
  db,
  env,
  findEvent,
  migrate,
  requireAuth,
  requireRole,
  start,
  z,
} from "@coldchainsg/common";
import { ZeroAddress, ZeroHash, decodeBytes32String, toUtf8String } from "ethers";
import { checkpointsFor, pendingCheckFor, registerQualityRoutes } from "./quality.ts";
import { qualitySchemaSql, schemaSql } from "./schema.ts";

await migrate(schemaSql);
await migrate(qualitySchemaSql);

const app = createApp();
const custody = () => contract("ShipmentCustody");

const STAGES = ["Origin", "Carrier", "Handler", "ColdStore", "Truck", "Delivered"] as const;
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Not a transaction hash");
const idSchema = z.coerce.number().int().positive();
const orNull = (a: string) => (a === ZeroAddress ? null : a);

// ---- Shapes returned to the frontend -----------------------------------------

function toUnitView(id: number, u: any, holders: string[], sensorId: string | null) {
  const isBatch = Number(u.kind) === 2;
  const code = toUtf8String(u.code).replace(/\0/g, "");
  return {
    id,
    kind: isBatch ? ("batch" as const) : ("container" as const),
    containerId: Number(u.containerId) || null, // a batch's container, once Cargo has received it
    custodian: orNull(u.custodian),
    pendingTo: orNull(u.pendingTo),
    stage: STAGES[Number(u.stage)],
    createdAt: Number(u.createdAt),
    unloadedAt: Number(u.unloadedAt) || null,
    containerCode: code || null, // ISO 6346; a batch carries its container's once loaded
    sealNumber: u.sealNumber === ZeroHash ? null : decodeBytes32String(u.sealNumber), // filled in for batches below
    holders, // everyone who has held it, oldest first
    sensorId, // the sensor covering its current stage (a batch inside a container: the container's)
    ...(isBatch && {
      supplier: u.supplier,
      buyer: u.buyer,
      inspector: u.inspector,
      thresholdC: Number(u.thresholdTenthsC) / 10,
      graceMinutes: Number(u.graceMinutes),
    }),
  };
}

type UnitView = ReturnType<typeof toUnitView> & { inContainer?: boolean };

async function readUnit(id: number) {
  const c = custody();
  const [u, history] = await Promise.all([c.getUnit(id), c.getHistory(id)]);
  const stage = Number(u.stage);
  const sensor = stage <= 4 ? await c.getSensor(id, stage) : null;
  const sensorId = sensor && sensor.device !== ZeroAddress ? decodeBytes32String(sensor.sensorId) : null;
  return toUnitView(id, u, [...new Set<string>(history.map((h: any) => h.custodian))], sensorId);
}

/** Every container and batch on-chain. Fine for a prototype with tens of shipments. */
async function allUnits(): Promise<UnitView[]> {
  const nextId = Number(await custody().nextId());
  const units: UnitView[] = await Promise.all(Array.from({ length: nextId - 1 }, (_, i) => readUnit(i + 1)));
  // A batch carries its container's seal, and stays inside it until the cold store unloads it.
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    if (u.kind !== "batch" || !u.containerId) continue;
    const box = byId.get(u.containerId)!;
    u.sealNumber = box.sealNumber;
    u.inContainer = !box.unloadedAt;
  }
  return units;
}

async function withMetadata(units: UnitView[]) {
  const ids = units.map((u) => u.id);
  const containers = await db.query("SELECT * FROM custody.containers WHERE id = ANY($1)", [ids]);
  const batches = await db.query("SELECT * FROM custody.batches WHERE id = ANY($1)", [ids]);
  const byId = new Map<number, any>([...containers.rows, ...batches.rows].map((row) => [row.id, row]));
  return units.map((u) => {
    const m = byId.get(u.id);
    const details =
      u.kind === "container"
        ? m && { mode: m.mode, voyage: m.voyage, origin: m.origin, destination: m.destination, departureDate: m.departure_date }
        : m && { product: m.product, quantity: Number(m.quantity), unit: m.unit };
    return { ...u, details: details ?? null };
  });
}

/** Anyone who holds, held, is about to receive, buys or inspects the unit. */
function involves(u: UnitView, wallet: string) {
  const w = wallet.toLowerCase();
  return [u.pendingTo, (u as any).supplier, (u as any).buyer, (u as any).inspector, ...u.holders].some((a) => a?.toLowerCase() === w);
}

// ---- Metadata for transactions sent from MetaMask ---------------------------------

/** The supplier describes a batch it just created on-chain. */
app.post("/batches", requireAuth, requireRole("SUPPLIER"), async (req, res) => {
  const { wallet } = req as AuthedRequest;
  const body = z
    .object({
      txHash: txHashSchema,
      product: z.string().trim().min(2).max(120),
      quantity: z.number().positive().max(1_000_000),
      unit: z.string().trim().min(1).max(20).default("kg"),
    })
    .parse(req.body);

  const event = await findEvent("ShipmentCustody", body.txHash, "BatchCreated");
  if (!event) throw new HttpError(400, "That transaction did not create a batch");
  if (event.supplier !== wallet) throw new HttpError(403, "That batch belongs to another supplier");

  const batchId = Number(event.batchId);
  await db.query(
    `INSERT INTO custody.batches (id, product, quantity, unit, tx_hash) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [batchId, body.product, body.quantity, body.unit, body.txHash],
  );
  res.status(201).json({ id: batchId });
});

/** Cargo describes a container it just opened on-chain: by air or sea, the voyage and route. */
app.post("/containers", requireAuth, requireRole("CARRIER"), async (req, res) => {
  const { wallet } = req as AuthedRequest;
  const body = z
    .object({
      txHash: txHashSchema,
      mode: z.enum(["air", "sea"]),
      voyage: z.string().trim().min(2).max(40), // flight or vessel/voyage number
      origin: z.string().trim().min(2).max(120),
      destination: z.string().trim().min(2).max(120),
      departureDate: z.iso.date(),
    })
    .parse(req.body);

  const event = await findEvent("ShipmentCustody", body.txHash, "ContainerCreated");
  if (!event) throw new HttpError(400, "That transaction did not open a container");
  if (event.carrier !== wallet) throw new HttpError(403, "That container belongs to another carrier");

  const id = Number(event.containerId);
  await db.query(
    `INSERT INTO custody.containers (id, mode, voyage, origin, destination, departure_date, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
    [id, body.mode, body.voyage, body.origin, body.destination, body.departureDate, body.txHash],
  );
  res.status(201).json({ id });
});

// ---- Read views ----------------------------------------------------------------

/** Shipments the caller is involved in (admins see everything). */
app.get("/shipments", requireAuth, async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  const units = await allUnits();
  const visible = role === "ADMIN" ? units : units.filter((u) => involves(u, wallet));
  res.json(await withMetadata(visible));
});

app.get("/shipments/:id", requireAuth, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const c = custody();
  if (id >= Number(await c.nextId())) throw new HttpError(404, "No such shipment");

  const units = await allUnits();
  const [unit] = await withMetadata([units[id - 1]]);
  const history = (await c.getHistory(id)).map((h: any) => ({
    custodian: h.custodian,
    stage: STAGES[Number(h.stage)],
    startedAt: Number(h.startedAt),
  }));
  const batchIds: bigint[] = unit.kind === "container" ? await c.getBatches(id) : [];
  const batches = await withMetadata(batchIds.map((b) => units[Number(b) - 1]));
  const container = unit.containerId ? (await withMetadata([units[unit.containerId - 1]]))[0] : null;

  const raw = await c.getUnit(id);
  const checkpoints = await checkpointsFor(id, raw);
  const pendingCheck = unit.pendingTo ? await pendingCheckFor(id) : null;

  // The sensor registered for each stage this unit passes through (a batch's 1-2 are its container's).
  const sensorStages = unit.kind === "container" ? [1, 2] : [0, 1, 2, 3, 4];
  const sensors = [];
  for (const stage of sensorStages) {
    if (unit.kind === "batch" && stage <= 2 && stage >= 1 && !unit.containerId) continue;
    const s = await c.getSensor(id, stage);
    if (s.device === ZeroAddress) continue;
    sensors.push({ stage, sensorId: decodeBytes32String(s.sensorId), device: s.device, owner: s.owner, registeredAt: Number(s.registeredAt) });
  }

  res.json({ ...unit, history, batches, container, checkpoints, pendingCheck, sensors });
});

registerQualityRoutes(app);
start(app, "custody-service", env.CUSTODY_PORT);
