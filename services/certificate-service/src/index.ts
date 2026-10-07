// Certificate Service. Drives the certificate lifecycle (see sync.ts) and serves certificate,
// claim, KPI and audit views. Resolutions and acknowledgements are signed by users in MetaMask.
import {
  type AuthedRequest,
  HttpError,
  contract,
  createApp,
  db,
  env,
  migrate,
  provider,
  requireAuth,
  requireRole,
  roleName,
  start,
  z,
} from "@coldchainsg/common";
import type { EventLog } from "ethers";
import { schemaSql } from "./schema.ts";
import { startSyncLoop, syncOnce } from "./sync.ts";

await migrate(schemaSql);

const app = createApp();
const certs = () => contract("CertificateRegistry");
const custody = () => contract("ShipmentCustody");

const PASS = ["pass", "flagged"] as const;
const OUTCOME = ["upheld", "overturned", "compensation_agreed"] as const;
const CERT = [null, "clean", "flagged", "resolved"] as const;
const DISPOSITION = [null, "released", "rejected"] as const;
const STAGES = [0, 1, 2, 3, 4];
const idSchema = z.coerce.number().int().positive();

/** CertificateRegistry FLAG_* bits, as readable reasons. */
const FLAG_REASONS: [number, string][] = [
  [1, "sensor_excursion"],
  [2, "receipt_temp"],
  [4, "unrefrigerated"],
  [8, "condition"],
];
const reasons = (flags: bigint | number) => FLAG_REASONS.filter(([bit]) => Number(flags) & bit).map(([, r]) => r);

// ---- Reading on-chain records -----------------------------------------------------

const ts = (n: bigint) => Number(n) || null;

async function readLegPass(id: bigint) {
  const lp = await certs().getLegPass(id);
  return {
    id: Number(id),
    shipmentId: Number(lp.shipmentId),
    batchId: Number(lp.batchId),
    leg: Number(lp.leg),
    custodian: lp.custodian,
    status: PASS[Number(lp.status)],
    reasons: reasons(lp.flags),
    receiptTempC: Number(lp.receiptTenthsC) / 10,
    unrefrigeratedMinutes: Number(lp.unrefrigeratedMinutes),
    fileHash: lp.fileHash,
    maxTempC: Number(lp.maxTenthsC) / 10,
    breachMinutes: Number(lp.breachMinutes),
    issuedAt: Number(lp.issuedAt),
  };
}

/** Live view of a stage, before or after its LegPass: flags so far and what evidence is in. */
async function readStage(batchId: number, stage: number) {
  const f = await certs().stageFlags(batchId, stage);
  return { stage, reasons: reasons(f.flags), checkpointDone: f.checkpointDone, sensorDone: f.sensorDone };
}

async function readClaim(id: number) {
  const c = await certs().getClaim(id);
  const notes = await db.query(
    "SELECT author, body, created_at FROM certificate.inspection_notes WHERE claim_id = $1 ORDER BY id",
    [id],
  );
  let resolution = null;
  if (c.resolutionId !== 0n) {
    const r = await certs().getResolution(c.resolutionId);
    resolution = {
      id: Number(c.resolutionId),
      inspector: r.inspector,
      outcome: OUTCOME[Number(r.outcome)],
      note: r.note,
      signedAt: Number(r.signedAt),
    };
  }
  const batchId = Number(c.batchId);
  const leg = Number(c.leg);
  return {
    id,
    batchId,
    leg,
    reasons: (await readStage(batchId, leg)).reasons,
    breachStart: ts(c.breachStart),
    breachEnd: ts(c.breachEnd),
    provisionalCustodian: c.provisionalCustodian,
    openedAt: Number(c.openedAt),
    status: resolution ? "resolved" : "open",
    resolution,
    inspectionNotes: notes.rows,
  };
}

async function readBatchCertificate(batchId: number) {
  const c = certs();
  const legPasses = [];
  const stages = [];
  for (const stage of STAGES) {
    const id: bigint = await c.legPassOf(batchId, stage);
    legPasses.push(id === 0n ? { leg: stage, pending: true } : await readLegPass(id));
    stages.push(await readStage(batchId, stage));
  }
  const claimIds: bigint[] = await c.getClaimsOfBatch(batchId);
  const claims = await Promise.all(claimIds.map((id) => readClaim(Number(id))));
  const cert = await c.getCertificate(batchId);
  const decision = await c.getDecision(batchId);
  const ack = await c.acknowledgements(batchId);
  return {
    batchId,
    stages,
    legPasses,
    claims,
    certificate:
      Number(cert.status) === 0
        ? null
        : {
            status: CERT[Number(cert.status)],
            legPassIds: cert.legPassIds.map(Number),
            resolutionIds: cert.resolutionIds.map(Number),
            issuedAt: Number(cert.issuedAt),
          },
    decision:
      Number(decision.disposition) === 0
        ? null
        : {
            disposition: DISPOSITION[Number(decision.disposition)],
            inspector: decision.inspector,
            note: decision.note,
            decidedAt: Number(decision.decidedAt),
          },
    acknowledgement:
      Number(ack.acknowledgedAt) === 0 ? null : { buyer: ack.buyer, acknowledgedAt: Number(ack.acknowledgedAt) },
  };
}

/** Batch ids the caller may see: admins see all; others see batches they import, buy or inspect. */
async function visibleBatchIds(wallet: string, role: string | null) {
  const cust = custody();
  const nextId = Number(await cust.nextId());
  const ids: number[] = [];
  for (let id = 1; id < nextId; id++) {
    const u = await cust.getUnit(id);
    if (Number(u.kind) !== 2) continue;
    if (role === "ADMIN" || [u.importer, u.buyer, u.inspector].includes(wallet)) ids.push(id);
  }
  return ids;
}

// ---- Certificates & claims ---------------------------------------------------------------

app.get("/certificates", requireAuth, async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  const ids = await visibleBatchIds(wallet, role);
  res.json(await Promise.all(ids.map(readBatchCertificate)));
});

app.get("/certificates/:batchId", requireAuth, async (req, res) => {
  const batchId = idSchema.parse(req.params.batchId);
  const unit = await custody().getUnit(batchId);
  if (Number(unit.kind) !== 2) throw new HttpError(404, "No such batch");
  res.json(await readBatchCertificate(batchId));
});

/**
 * Claims the caller is involved in: as the batch's importer, buyer or inspector, or as the
 * provisional custodian the claim is tagged to. ?status=open|resolved filters.
 */
app.get("/claims", requireAuth, async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  const status = z.enum(["open", "resolved"]).optional().parse(req.query.status);
  const visible = new Set(await visibleBatchIds(wallet, role));

  const count = Number(await certs().claimCount());
  const all = await Promise.all(Array.from({ length: count }, (_, i) => readClaim(i + 1)));
  res.json(
    all.filter(
      (c) => (visible.has(c.batchId) || c.provisionalCustodian === wallet) && (!status || c.status === status),
    ),
  );
});

app.get("/claims/:id", requireAuth, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  if (id > Number(await certs().claimCount())) throw new HttpError(404, "No such claim");
  res.json(await readClaim(id));
});

/** Off-chain inspection notes (the signed resolution note itself is on-chain). */
app.post("/claims/:id/notes", requireAuth, requireRole("INSPECTOR", "BUYER"), async (req, res) => {
  const { wallet } = req as AuthedRequest;
  const claimId = idSchema.parse(req.params.id);
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);

  const claim = await certs().getClaim(claimId);
  if (Number(claim.openedAt) === 0) throw new HttpError(404, "No such claim");
  const batch = await custody().getUnit(claim.batchId);
  if (![batch.buyer, batch.inspector].includes(wallet)) throw new HttpError(403, "Not your batch");

  await db.query("INSERT INTO certificate.inspection_notes (claim_id, author, body) VALUES ($1, $2, $3)", [
    claimId,
    wallet,
    body,
  ]);
  res.status(201).json(await readClaim(claimId));
});

// ---- Lifecycle sync --------------------------------------------------------------------

/** Runs a sync pass now instead of waiting for the next tick (handy in the demo and tests). */
app.post("/sync", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  res.json({ actions: await syncOnce() });
});

// ---- KPIs (admin overview) -------------------------------------------------------------------

app.get("/kpis", requireAuth, async (_req, res) => {
  const all = await visibleBatchIds("", "ADMIN");
  const batches = await Promise.all(all.map(readBatchCertificate));
  const certified = batches.filter((b) => b.certificate);
  const claims = batches.flatMap((b) => b.claims);
  const resolved = claims.filter((c) => c.resolution);
  const hours = resolved.map((c) => (c.resolution!.signedAt - c.openedAt) / 3600);

  const checkedStages = batches.flatMap((b) => b.stages).filter((st) => st.checkpointDone);
  const passes = batches
    .flatMap((b) => b.legPasses)
    .filter((lp): lp is Awaited<ReturnType<typeof readLegPass>> => "id" in lp);

  const byStatus = (s: string) => certified.filter((b) => b.certificate!.status === s).length;
  const byOutcome = (o: string) => resolved.filter((c) => c.resolution!.outcome === o).length;

  res.json({
    batches: batches.length,
    certified: certified.length,
    clean: byStatus("clean"),
    flagged: byStatus("flagged"),
    resolved: byStatus("resolved"),
    cleanRate: certified.length ? byStatus("clean") / certified.length : null,
    acknowledged: batches.filter((b) => b.acknowledgement).length,
    claims: { open: claims.length - resolved.length, resolved: resolved.length },
    avgResolutionHours: hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null,
    outcomes: { upheld: byOutcome("upheld"), overturned: byOutcome("overturned"), compensation_agreed: byOutcome("compensation_agreed") },
    // Handover checkpoints completed so far, and how many failed.
    checkpoints: { completed: checkedStages.length, flagged: checkedStages.filter((st) => st.reasons.length).length },
    // Which stage the problems came from: where in the chain things go wrong.
    claimsByLeg: STAGES.map((leg) => ({ leg, claims: claims.filter((c) => c.leg === leg).length })),
    // Why stages were flagged (a stage can have several reasons).
    flagReasons: Object.fromEntries(
      FLAG_REASONS.map(([, r]) => [r, batches.flatMap((b) => b.stages).filter((st) => st.reasons.includes(r)).length]),
    ),
    // Stages 0-2 are one handover per container, shared by its batches: count each container once.
    unrefrigeratedMinutesByLeg: STAGES.map((leg) => {
      const seen = new Set<string>();
      const minutes = passes
        .filter((lp) => lp.leg === leg)
        .filter((lp) => {
          const key = leg <= 2 ? `c${lp.shipmentId}` : `b${lp.batchId}`;
          return seen.has(key) ? false : (seen.add(key), true);
        })
        .reduce((sum, lp) => sum + lp.unrefrigeratedMinutes, 0);
      return { leg, minutes };
    }),
    dispositions: {
      released: batches.filter((b) => b.decision?.disposition === "released").length,
      rejected: batches.filter((b) => b.decision?.disposition === "rejected").length,
      awaiting: certified.filter((b) => !b.decision).length,
    },
  });
});

// ---- Audit log: every platform event, straight from the chain -----------------------------------

/** Event args as JSON-friendly values (bigints, including inside arrays, become numbers). */
const plain = (value: unknown): unknown =>
  typeof value === "bigint" ? Number(value) : Array.isArray(value) ? [...value].map(plain) : value;

const AUDITED = ["ParticipantRegistry", "ShipmentCustody", "SensorOracle", "CertificateRegistry"];
const NOISE = new Set(["RoleGranted", "RoleRevoked", "RoleAdminChanged"]); // duplicated by our own events

app.get("/audit", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit);
  const events: { contract: string; event: string; args: Record<string, unknown>; block: number; txHash: string; logIndex: number }[] = [];

  for (const name of AUDITED) {
    const c = contract(name);
    for (const log of (await c.queryFilter("*", 0)) as EventLog[]) {
      if (!log.fragment || NOISE.has(log.fragment.name)) continue;
      const args: Record<string, unknown> = {};
      log.fragment.inputs.forEach((input, i) => {
        const value = log.args[i];
        args[input.name] = input.name === "role" ? roleName(value) : plain(value);
      });
      events.push({ contract: name, event: log.fragment.name, args, block: log.blockNumber, txHash: log.transactionHash, logIndex: log.index });
    }
  }

  events.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
  const page = events.slice(0, limit);
  const timestamps = new Map<number, number>();
  for (const e of page) {
    if (!timestamps.has(e.block)) timestamps.set(e.block, (await provider.getBlock(e.block))!.timestamp);
  }
  res.json(page.map((e) => ({ ...e, at: timestamps.get(e.block) })));
});

startSyncLoop();
start(app, "certificate-service", env.CERTIFICATE_PORT);
