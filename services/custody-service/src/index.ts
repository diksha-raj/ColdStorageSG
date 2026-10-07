// Custody Service. Users send custody transactions (create, add batch, handover, split)
// from MetaMask; this service stores the off-chain details and serves read views that
// combine on-chain custody state with that metadata.
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
import { decodeBytes32String } from "ethers";
import { checkpointsFor, pendingCheckFor, registerQualityRoutes } from "./quality.ts";
import { qualitySchemaSql, schemaSql } from "./schema.ts";

await migrate(schemaSql);
await migrate(qualitySchemaSql);

const app = createApp();
const custody = () => contract("ShipmentCustody");

const STAGES = ["Origin", "Carrier", "Handler", "ColdStore", "Truck", "Delivered"] as const;
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Not a transaction hash");
const idSchema = z.coerce.number().int().positive();

// ---- Shapes returned to the frontend -----------------------------------------

function toUnitView(id: number, u: any) {
  const isBatch = Number(u.kind) === 2;
  return {
    id,
    kind: isBatch ? "batch" : "container",
    containerId: Number(u.containerId),
    importer: u.importer,
    custodian: u.custodian === "0x0000000000000000000000000000000000000000" ? null : u.custodian,
    pendingTo: u.pendingTo === "0x0000000000000000000000000000000000000000" ? null : u.pendingTo,
    stage: STAGES[Number(u.stage)],
    splitAt: Number(u.splitAt) || null,
    sensorId: decodeBytes32String(u.sensorId),
    ...(isBatch && {
      buyer: u.buyer,
      inspector: u.inspector,
      thresholdC: Number(u.thresholdTenthsC) / 10,
      graceMinutes: Number(u.graceMinutes),
    }),
  };
}

type UnitView = ReturnType<typeof toUnitView>;

/** Every container and batch on-chain. Fine for a prototype with tens of shipments. */
async function allUnits(): Promise<UnitView[]> {
  const c = custody();
  const nextId = Number(await c.nextId());
  const ids = Array.from({ length: nextId - 1 }, (_, i) => i + 1);
  return Promise.all(ids.map(async (id) => toUnitView(id, await c.getUnit(id))));
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
        ? m && { origin: m.origin, departureDate: m.departure_date }
        : m && { product: m.product, quantity: Number(m.quantity), unit: m.unit };
    return { ...u, details: details ?? null };
  });
}

function involves(u: UnitView, wallet: string) {
  const w = wallet.toLowerCase();
  return [u.importer, u.custodian, u.pendingTo, (u as any).buyer, (u as any).inspector].some(
    (a) => a?.toLowerCase() === w,
  );
}

// ---- Metadata for transactions sent from MetaMask ---------------------------------

app.post("/containers", requireAuth, requireRole("IMPORTER"), async (req, res) => {
  const { wallet } = req as AuthedRequest;
  const body = z
    .object({
      txHash: txHashSchema,
      origin: z.string().trim().min(2).max(120),
      departureDate: z.iso.date(),
    })
    .parse(req.body);

  const event = await findEvent("ShipmentCustody", body.txHash, "ContainerCreated");
  if (!event) throw new HttpError(400, "That transaction did not create a container");
  if (event.importer !== wallet) throw new HttpError(403, "That container belongs to another importer");

  const id = Number(event.containerId);
  await db.query(
    `INSERT INTO custody.containers (id, origin, departure_date, tx_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, body.origin, body.departureDate, body.txHash],
  );
  res.status(201).json({ id });
});

app.post("/batches", requireAuth, requireRole("IMPORTER"), async (req, res) => {
  const { wallet } = req as AuthedRequest;
  const body = z
    .object({
      txHash: txHashSchema,
      product: z.string().trim().min(2).max(120),
      quantity: z.number().positive().max(1_000_000),
      unit: z.string().trim().min(1).max(20).default("kg"),
    })
    .parse(req.body);

  const event = await findEvent("ShipmentCustody", body.txHash, "BatchAdded");
  if (!event) throw new HttpError(400, "That transaction did not add a batch");
  const batchId = Number(event.batchId);
  const batch = await custody().getUnit(batchId);
  if (batch.importer !== wallet) throw new HttpError(403, "That batch belongs to another importer");

  await db.query(
    `INSERT INTO custody.batches (id, container_id, product, quantity, unit, tx_hash) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [batchId, Number(event.containerId), body.product, body.quantity, body.unit, body.txHash],
  );
  res.status(201).json({ id: batchId });
});

// ---- Read views ----------------------------------------------------------------

/** Shipments the caller is involved in (admins see everything). */
app.get("/shipments", requireAuth, async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  const units = await allUnits();
  const visible = role === "ADMIN" ? units : units.filter((u) => involves(u, wallet));
  // Before the split a batch travels inside its container: attach where that container is,
  // since buyers and inspectors can't see the container itself.
  const byId = new Map(units.map((u) => [u.id, u]));
  const withContainer = visible.map((u) =>
    u.kind === "batch" ? { ...u, container: { stage: byId.get(u.containerId)!.stage, splitAt: byId.get(u.containerId)!.splitAt } } : u,
  );
  res.json(await withMetadata(withContainer));
});

app.get("/shipments/:id", requireAuth, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const c = custody();
  if (id >= Number(await c.nextId())) throw new HttpError(404, "No such shipment");

  const [unit] = await withMetadata([toUnitView(id, await c.getUnit(id))]);
  const historyOf = async (unitId: number) =>
    (await c.getHistory(unitId)).map((h: any) => ({
      custodian: h.custodian,
      stage: STAGES[Number(h.stage)],
      startedAt: Number(h.startedAt),
    }));

  // A batch's full custody chain = its container's history up to the split, then its own.
  const history =
    unit.kind === "batch" ? [...(await historyOf(unit.containerId)), ...(await historyOf(id))] : await historyOf(id);

  const batchIds: bigint[] = unit.kind === "container" ? await c.getBatches(id) : [];
  const batches = await withMetadata(
    await Promise.all(batchIds.map(async (b) => toUnitView(Number(b), await c.getUnit(b)))),
  );

  const raw = await c.getUnit(id);
  const checkpoints = await checkpointsFor(id, raw);
  const pendingCheck = unit.pendingTo ? await pendingCheckFor(id) : null;
  res.json({ ...unit, history, batches, checkpoints, pendingCheck });
});

/** Who held a shipment at a given unix time — the basis for tagging claims. */
app.get("/shipments/:id/custodian-at", requireAuth, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const at = z.coerce.number().int().nonnegative().parse(req.query.at);
  const [custodian, stage] = await custody().getCustodianAt(id, at);
  res.json({ id, at, custodian, stage: STAGES[Number(stage)] });
});

registerQualityRoutes(app);
start(app, "custody-service", env.CUSTODY_PORT);
