// End-to-end certificate lifecycle. Needs the chain, a deployment, and all five services running.
//
// Two batches from one supplier, one container, the same journey:
//   salmon (4 °C, 15 min grace)  stage 1: the handler measures 7.1 °C on receipt  → flagged in transit, QA rules at once
//                                stage 2: 20 minutes on the dock before the cold store signs in → flagged
//                                stage 3: the truck finds the salmon's packaging damaged       → flagged; QA REJECTS the batch
//   cheese (8 °C, 30 min grace)  the same temperatures and dock time are within its limits    → clean; QA RELEASES it
// Every party uses a demo sensor that reads compliant, so these flags come from the handover checks.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { AUTO_NUMBER, OK_CHECK, SEAL, adminToken, api, deployed, persona, provider } from "@coldchainsg/common/testing";
import { encodeBytes32String } from "ethers";

const certApi = api(`http://localhost:${process.env.CERTIFICATE_PORT ?? 4004}`);
const gatewayApi = api(`http://localhost:${process.env.GATEWAY_PORT ?? 4005}`);

let p: Record<string, Awaited<ReturnType<typeof persona>>>;
let admin: string;
let container: number;
let salmon: number;
let cheese: number;

const as = (who: string, name = "ShipmentCustody") => deployed(name, p[who].signer);
const send = async (who: string, fn: string, ...args: unknown[]) => (await as(who)[fn](...args)).wait();
const sendCert = async (who: string, fn: string, ...args: unknown[]) => (await as(who, "CertificateRegistry")[fn](...args)).wait();
const Disposition = { Released: 1, Rejected: 2 };
const Outcome = { Upheld: 0, Overturned: 1, CompensationAgreed: 2 };
const sync = async () => assert.equal((await certApi("/sync", { token: admin, body: {} })).status, 200);
const certificate = async (batchId: number, who = "inspector") => (await certApi(`/certificates/${batchId}`, { token: p[who].token })).body;

/** A demo sensor that reads compliant, registered with the gateway and then on-chain. */
async function demoSensor(who: string, ids: number[]) {
  const res = await gatewayApi("/sensors", { token: p[who].token, body: { mode: "compliant" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await send(who, "registerSensor", ids, encodeBytes32String(res.body.sensorId), res.body.device);
}

/** Moves the test chain's clock on, instead of waiting. */
const travel = async (seconds: number) => {
  const latest = (await provider.getBlock("latest"))!.timestamp;
  await provider.send("evm_setNextBlockTimestamp", [latest + seconds]);
  await provider.send("evm_mine", []);
};

/** Waits for the sensors and oracle to report, then for the certificate service to act. */
async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 80; i++) {
    await sync();
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  p = {};
  for (const [name, role] of [
    ["supplier", "SUPPLIER"],
    ["carrier", "CARRIER"],
    ["handler", "HANDLER"],
    ["coldStore", "COLD_STORE"],
    ["truck", "TRUCK"],
    ["salmonBuyer", "BUYER"],
    ["cheeseBuyer", "BUYER"],
    ["inspector", "INSPECTOR"],
    ["stranger", "BUYER"],
  ] as const) {
    p[name] = await persona(role);
  }
  admin = await adminToken();
});

test("stage 1: the handler finds the container warm on receipt", async () => {
  salmon = Number(await deployed("ShipmentCustody", provider).nextId());
  cheese = salmon + 1;
  container = salmon + 2;
  await send("supplier", "createBatch", p.salmonBuyer.address, p.inspector.address, 40, 15);
  await send("supplier", "createBatch", p.cheeseBuyer.address, p.inspector.address, 80, 30);
  await demoSensor("supplier", [salmon, cheese]);
  await send("carrier", "createContainer", AUTO_NUMBER);
  await demoSensor("carrier", [container]);
  for (const b of [salmon, cheese]) {
    await send("supplier", "initiateTransfer", b, p.carrier.address, OK_CHECK);
    await send("carrier", "acceptIntoContainer", b, container, OK_CHECK);
  }
  await send("carrier", "recordSeal", container, SEAL);
  await send("carrier", "initiateTransfer", container, p.handler.address, { ...OK_CHECK, tempTenthsC: 34 });
  await send("handler", "acceptTransfer", container, { ...OK_CHECK, tempTenthsC: 71, issues: true });
  await sync();
});

test("a failed handover opens a claim at once, while the batch is still in transit", async () => {
  await waitFor(async () => (await certificate(salmon)).claims.length === 1, "the salmon's stage 1 claim");
  const s = await certificate(salmon);
  assert.deepEqual(
    s.claims.map((c: any) => [c.leg, c.provisionalCustodian, c.reasons]),
    [[1, p.carrier.address, ["receipt_temp", "condition"]]],
  );
  assert.equal(s.certificate, null, "no certificate yet: the batch is still with the handler");
  // "Accepted with issues" flags the cheese's stage 1 too; 7.1 °C is within its 8 °C limit.
  assert.deepEqual((await certificate(cheese)).stages[1].reasons, ["condition"]);

  // QA rules while the batch is still in transit.
  const claimId = s.claims[0].id;
  await sendCert("inspector", "submitResolution", claimId, Outcome.Upheld, "Cargo's reefer reading confirms the warm hold");
  assert.equal((await certificate(salmon)).claims[0].status, "resolved");
});

test("stage 2: 20 minutes on the dock before the cold store signs in; stage 3: the truck finds damage", async () => {
  await send("handler", "initiateTransfer", container, p.coldStore.address, OK_CHECK);
  await travel(20 * 60); // 20 minutes on the dock
  await send("coldStore", "acceptTransfer", container, OK_CHECK);
  await demoSensor("coldStore", [salmon, cheese]);
  await send("coldStore", "unloadContainer", container);
  for (const b of [salmon, cheese]) {
    await send("coldStore", "initiateTransfer", b, p.truck.address, OK_CHECK);
    await send("truck", "acceptTransfer", b, { ...OK_CHECK, damaged: b === salmon });
  }
  await demoSensor("truck", [salmon, cheese]);
  for (const [b, buyer] of [
    [salmon, "salmonBuyer"],
    [cheese, "cheeseBuyer"],
  ] as const) {
    await send("truck", "initiateTransfer", b, p[buyer].address, OK_CHECK);
    await send(buyer, "acceptTransfer", b, OK_CHECK);
  }

  await waitFor(async () => (await certificate(salmon)).certificate !== null && (await certificate(cheese)).certificate !== null, "both certificates");
  const s = await certificate(salmon);
  assert.deepEqual(s.stages[2].reasons, ["handover_gap"]);
  assert.deepEqual(s.stages[3].reasons, ["condition"]);
  const gap = s.legPasses.find((lp: any) => lp.leg === 2).gapMinutes;
  assert.ok(gap >= 20 && gap <= 22, `gap was ${gap} min`);
  assert.equal(s.certificate.status, "flagged", "two stages still await QA");
  assert.deepEqual(s.claims.map((c: any) => [c.leg, c.provisionalCustodian]).sort(), [
    [1, p.carrier.address],
    [2, p.handler.address],
    [3, p.coldStore.address],
  ]);

  const c = await certificate(cheese);
  assert.deepEqual(c.stages[2].reasons, [], "20 minutes is inside the cheese's 30-minute grace period");
  assert.equal(c.certificate.status, "flagged", "its stage 1 condition flag still awaits QA");
});

test("QA can't decide the batch until every flagged stage is ruled on; the buyer can't close it before QA decides", async () => {
  await assert.rejects(sendCert("inspector", "submitDisposition", salmon, Disposition.Rejected, "too early"), /rule on every flagged stage first/);
  for (const claim of (await certificate(salmon)).claims.filter((c: any) => c.status === "open")) {
    await sendCert("inspector", "submitResolution", claim.id, Outcome.Upheld, `Stage ${claim.leg}: custodian responsible`);
  }
  assert.equal((await certificate(salmon)).certificate.status, "resolved");
  await assert.rejects(sendCert("salmonBuyer", "acknowledgeReceipt", salmon), /awaiting QA decision/);
});

test("QA rejects the salmon and releases the cheese; each buyer closes their batch", async () => {
  await sendCert("inspector", "submitDisposition", salmon, Disposition.Rejected, "Warm at Changi, 20 min on the dock, damaged at pickup");
  await sendCert("salmonBuyer", "acknowledgeReceipt", salmon);
  const cheeseClaim = (await certificate(cheese)).claims[0];
  await sendCert("inspector", "submitResolution", cheeseClaim.id, Outcome.Overturned, "Issue was the salmon's carton only");
  await sendCert("inspector", "submitDisposition", cheese, Disposition.Released, "Within limits throughout");
  await sendCert("cheeseBuyer", "acknowledgeReceipt", cheese);

  const s = await certificate(salmon);
  assert.equal(s.decision.disposition, "rejected");
  assert.equal(s.acknowledgement.buyer, p.salmonBuyer.address);
  assert.equal((await certificate(cheese)).decision.disposition, "released");
});

test("buyers only see their own certificates", async () => {
  const ids = async (who: string) => (await certApi("/certificates", { token: p[who].token })).body.map((c: any) => c.batchId);
  assert.deepEqual(await ids("salmonBuyer"), [salmon]);
  assert.deepEqual(await ids("cheeseBuyer"), [cheese]);
  assert.deepEqual(await ids("stranger"), []);
  assert.deepEqual((await ids("truck")).sort(), [salmon, cheese].sort(), "the truck sees what it carried");
});

test("KPIs and the audit log reflect the handovers and QA decisions", async () => {
  const kpis = (await certApi("/kpis", { token: admin })).body;
  assert.ok(kpis.flagReasons.handover_gap >= 1);
  assert.ok(kpis.gapMinutesByStage.find((g: any) => g.leg === 2).minutes >= 20);
  assert.ok(kpis.dispositions.rejected >= 1 && kpis.dispositions.released >= 1);

  const audit = (await certApi("/audit?limit=500", { token: admin })).body;
  const names = new Set(audit.map((e: any) => e.event));
  for (const e of ["BatchCreated", "SensorRegistered", "BatchLoaded", "FileHashCommitted", "LegSummarySubmitted", "DispositionSubmitted"]) {
    assert.ok(names.has(e), `audit has ${e}`);
  }
  assert.equal((await certApi("/audit", { token: p.inspector.token })).status, 403);
});
