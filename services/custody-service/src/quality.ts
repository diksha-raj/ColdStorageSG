// Quality checks while a custodian holds a shipment, and the handover checkpoints.
//
//   During the leg   the holder records spot temperature readings and issue reports (off-chain, instant).
//   At handover      POST /shipments/:id/seal freezes them (with a note) into a JSON snapshot and returns
//                    its keccak256 hash. The sender puts that hash in the outgoing check they sign in
//                    initiateTransfer; the receiver seals their own note for the incoming check in
//                    acceptTransfer. The snapshot can't be edited afterwards without breaking the hash.
import { type AuthedRequest, HttpError, contract, db, requireAuth, z } from "@coldchainsg/common";
import { ZeroAddress, ZeroHash, id as keccakText } from "ethers";
import type { Express } from "express";

const custody = () => contract("ShipmentCustody");
const STAGE_DELIVERED = 5;

export const ISSUE_CATEGORIES = [
  "refrigeration_failure",
  "temperature_excursion",
  "packaging_damage",
  "seal_broken",
  "delay",
  "other",
] as const;

const idSchema = z.coerce.number().int().positive();

/**
 * The (unit, stage) pairs whose entries belong to a holder's current leg. After the split, a
 * batch's cold-store leg also includes what was recorded on its container at the cold store.
 */
function logScope(unitId: number, u: any): [number, number][] {
  const stage = Number(u.stage);
  const scope: [number, number][] = [[unitId, stage]];
  if (Number(u.kind) === 2 && stage === 3) scope.push([Number(u.containerId), 3]);
  return scope;
}

async function legLog(scope: [number, number][]) {
  const where = scope.map((_, i) => `(unit_id = $${i * 2 + 1} AND stage = $${i * 2 + 2})`).join(" OR ");
  const params = scope.flat();
  const readings = (
    await db.query(`SELECT taken_at, temp_c, note, wallet FROM custody.readings WHERE ${where} ORDER BY taken_at, id`, params)
  ).rows.map((r) => ({ takenAt: new Date(r.taken_at).toISOString(), tempC: Number(r.temp_c), note: r.note, by: r.wallet }));
  const issues = (
    await db.query(
      `SELECT category, unrefrigerated_minutes, description, created_at, wallet FROM custody.issues WHERE ${where} ORDER BY created_at, id`,
      params,
    )
  ).rows.map((r) => ({
    category: r.category,
    unrefrigeratedMinutes: r.unrefrigerated_minutes,
    description: r.description,
    reportedAt: new Date(r.created_at).toISOString(),
    by: r.wallet,
  }));
  return {
    readings,
    issues,
    digest: {
      readings: readings.length,
      maxTempC: readings.length ? Math.max(...readings.map((r) => r.tempC)) : null,
      issues: issues.length,
      unrefrigeratedMinutes: issues.reduce((sum, i) => sum + i.unrefrigeratedMinutes, 0),
    },
  };
}

function formatCheck(c: any) {
  if (Number(c.checkedAt) === 0) return null;
  return {
    tempC: Number(c.tempTenthsC) / 10,
    unrefrigeratedMinutes: Number(c.unrefrigeratedMinutes),
    damaged: c.damaged,
    sealIntact: c.sealIntact,
    issues: c.issues,
    notesHash: c.notesHash,
    by: c.by,
    checkedAt: Number(c.checkedAt),
  };
}

async function sealedBody(hash: string) {
  if (!hash || hash === ZeroHash) return null;
  const { rows } = await db.query("SELECT body FROM custody.sealed_notes WHERE notes_hash = $1", [hash]);
  return rows[0] ? JSON.parse(rows[0].body) : null;
}

/** Every handover checkpoint relevant to a unit: a batch sees its container's (stages 0-2) and its own (3-4). */
export async function checkpointsFor(unitId: number, u: any) {
  const isBatch = Number(u.kind) === 2;
  const pairs: [number, number][] = isBatch
    ? [
        [Number(u.containerId), 0],
        [Number(u.containerId), 1],
        [Number(u.containerId), 2],
        [unitId, 3],
        [unitId, 4],
      ]
    : [
        [unitId, 0],
        [unitId, 1],
        [unitId, 2],
      ];
  const out = [];
  for (const [unit, stage] of pairs) {
    const cp = await custody().getCheckpoint(unit, stage);
    const outgoing = formatCheck(cp.outgoing);
    const incoming = formatCheck(cp.incoming);
    out.push({
      stage,
      recordedOn: unit,
      outgoing: outgoing && { ...outgoing, sealed: await sealedBody(outgoing.notesHash) },
      incoming: incoming && { ...incoming, sealed: await sealedBody(incoming.notesHash) },
    });
  }
  return out;
}

export async function pendingCheckFor(unitId: number) {
  const c = formatCheck(await custody().getPendingCheck(unitId));
  return c && { ...c, sealed: await sealedBody(c.notesHash) };
}

export function registerQualityRoutes(app: Express) {
  const holderOf = async (req: AuthedRequest) => {
    const unitId = idSchema.parse(req.params.id);
    const c = custody();
    if (unitId >= Number(await c.nextId())) throw new HttpError(404, "No such shipment");
    const u = await c.getUnit(unitId);
    return { unitId, u };
  };
  const requireHolder = (u: any, wallet: string) => {
    if (u.custodian !== wallet) throw new HttpError(403, "Only the current custodian can record checks on this shipment");
    if (Number(u.stage) === STAGE_DELIVERED) throw new HttpError(409, "This shipment has been delivered");
  };

  /** The current holder's leg log: readings and issues so far, with a digest for the handover form. */
  app.get("/shipments/:id/log", requireAuth, async (req, res) => {
    const { unitId, u } = await holderOf(req as AuthedRequest);
    res.json({ stage: Number(u.stage), ...(await legLog(logScope(unitId, u))) });
  });

  app.post("/shipments/:id/readings", requireAuth, async (req, res) => {
    const { wallet } = req as AuthedRequest;
    const { unitId, u } = await holderOf(req as AuthedRequest);
    requireHolder(u, wallet);
    const body = z
      .object({
        tempC: z.number().min(-40).max(60),
        takenAt: z.iso.datetime({ offset: true }).optional(),
        note: z.string().trim().max(300).default(""),
      })
      .parse(req.body);
    const takenAt = body.takenAt ? new Date(body.takenAt) : new Date();
    if (takenAt.getTime() > Date.now() + 60_000) throw new HttpError(400, "A reading can't be in the future");

    await db.query(
      "INSERT INTO custody.readings (unit_id, stage, wallet, taken_at, temp_c, note) VALUES ($1, $2, $3, $4, $5, $6)",
      [unitId, Number(u.stage), wallet, takenAt, body.tempC, body.note],
    );
    res.status(201).json(await legLog(logScope(unitId, u)));
  });

  app.post("/shipments/:id/issues", requireAuth, async (req, res) => {
    const { wallet } = req as AuthedRequest;
    const { unitId, u } = await holderOf(req as AuthedRequest);
    requireHolder(u, wallet);
    const body = z
      .object({
        category: z.enum(ISSUE_CATEGORIES),
        unrefrigeratedMinutes: z.number().int().min(0).max(10080).default(0),
        description: z.string().trim().min(3).max(1000),
      })
      .parse(req.body);

    await db.query(
      "INSERT INTO custody.issues (unit_id, stage, wallet, category, unrefrigerated_minutes, description) VALUES ($1, $2, $3, $4, $5, $6)",
      [unitId, Number(u.stage), wallet, body.category, body.unrefrigeratedMinutes, body.description],
    );
    res.status(201).json(await legLog(logScope(unitId, u)));
  });

  /**
   * Freezes a handover note into a snapshot and returns its hash, for the check the caller is about
   * to sign. "out": the holder, sealing their leg's readings + issues + note. "in": the named
   * recipient of a pending transfer, sealing their receipt note.
   */
  app.post("/shipments/:id/seal", requireAuth, async (req, res) => {
    const { wallet } = req as AuthedRequest;
    const { unitId, u } = await holderOf(req as AuthedRequest);
    const { direction, note } = z
      .object({ direction: z.enum(["out", "in"]), note: z.string().trim().max(1000).default("") })
      .parse(req.body);

    let snapshot: object;
    if (direction === "out") {
      requireHolder(u, wallet);
      const log = await legLog(logScope(unitId, u));
      snapshot = { kind: "coldchainsg.handover.out", unitId, stage: Number(u.stage), by: wallet, readings: log.readings, issues: log.issues, note, sealedAt: new Date().toISOString() };
    } else {
      if (u.pendingTo === ZeroAddress || u.pendingTo !== wallet) throw new HttpError(403, "No transfer is pending for you");
      snapshot = { kind: "coldchainsg.handover.in", unitId, stage: Number(u.stage), by: wallet, note, sealedAt: new Date().toISOString() };
    }

    // The exact string is stored, so anyone can recompute keccak256(body) and compare it on-chain.
    const body = JSON.stringify(snapshot);
    const notesHash = keccakText(body);
    await db.query(
      `INSERT INTO custody.sealed_notes (notes_hash, unit_id, stage, direction, wallet, body)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (notes_hash) DO NOTHING`,
      [notesHash, unitId, Number(u.stage), direction, wallet, body],
    );
    res.status(201).json({ notesHash, snapshot });
  });
}
