// End-to-end certificate lifecycle. Needs the chain, a deployment, and all four services running.
//
// One container, two batches, same journey:
//   salmon (limit 4 °C)  stage 1: handler measures 7.1 °C on receipt  → flagged in transit, QA rules immediately
//                        stage 2: sensor log shows a 34-min breach    → flagged
//                        stage 3: cold store reports packaging damage → flagged; QA finally REJECTS the batch
//   cheese (limit 8 °C)  the same temperatures never exceed 8 °C      → clean; QA RELEASES it
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { OK_CHECK, adminToken, api, deployed, persona, provider } from "@coldchainsg/common/testing";
import { encodeBytes32String } from "ethers";

const certApi = api(`http://localhost:${process.env.CERTIFICATE_PORT ?? 4004}`);
const oracleApi = api(`http://localhost:${process.env.ORACLE_PORT ?? 4003}`);
const run = Math.random().toString(36).slice(2, 7).toUpperCase();

let p: Record<string, Awaited<ReturnType<typeof persona>>>;
let admin: string;
let containerId: number;
let salmon: number;
let cheese: number;

const as = (who: string, name = "ShipmentCustody") => deployed(name, p[who].signer);
const send = async (who: string, fn: string, ...args: unknown[]) => (await as(who)[fn](...args)).wait();
const sendCert = async (who: string, fn: string, ...args: unknown[]) =>
  (await as(who, "CertificateRegistry")[fn](...args)).wait();
const setRecording = async (shipmentId: number, leg: number, recording: string) => {
  const res = await oracleApi(`/legs/${shipmentId}/${leg}/recording`, { method: "PUT", token: admin, body: { recording } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};
/** The custodian who held the leg uploads a logger file, once the sensor has committed. */
const upload = async (who: string, shipmentId: number, leg: number, demoFile: string) => {
  for (let i = 0; i < 40; i++) {
    const res = await oracleApi(`/legs/${shipmentId}/${leg}/upload`, { token: p[who].token, body: { demoFile } });
    if (res.status === 201) return res.body;
    if (!/sensor hasn't reported/.test(res.body.error)) assert.fail(JSON.stringify(res.body));
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail("sensor never committed");
};
const Disposition = { Released: 1, Rejected: 2 };
const Outcome = { Upheld: 0, Overturned: 1, CompensationAgreed: 2 };
/** One handover: sender signs an outgoing check, receiver an incoming one. */
const handover = async (unit: number, from: string, to: string, out: Partial<typeof OK_CHECK> = {}, inc: Partial<typeof OK_CHECK> = {}) => {
  await send(from, "initiateTransfer", unit, p[to].address, { ...OK_CHECK, ...out });
  await send(to, "acceptTransfer", unit, { ...OK_CHECK, ...inc });
};
const sync = async () => assert.equal((await certApi("/sync", { token: admin, body: {} })).status, 200);
const certificate = async (batchId: number, who = "inspector") =>
  (await certApi(`/certificates/${batchId}`, { token: p[who].token })).body;

before(async () => {
  p = {};
  for (const [name, role] of [
    ["importer", "IMPORTER"],
    ["carrier", "CARRIER"],
    ["handler", "HANDLER"],
    ["coldStore", "COLD_STORE"],
    ["truck", "TRUCK"],
    ["salmonBuyer", "BUYER"],
    ["cheeseBuyer", "BUYER"],
    ["inspector", "INSPECTOR"],
    ["otherInspector", "INSPECTOR"],
  ] as const) {
    p[name] = await persona(role);
  }
  admin = await adminToken();
  for (const id of ["CTR", "SAL", "CHE"]) {
    const res = await oracleApi("/sensors", { token: admin, body: { sensorId: `${id}-${run}`, label: id } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
});

test("dispatch and stage 1: the handler finds the container warm on receipt", async () => {
  containerId = Number(await deployed("ShipmentCustody", provider).nextId());
  salmon = containerId + 1;
  cheese = containerId + 2;
  await send("importer", "createContainer", encodeBytes32String(`CTR-${run}`));
  await send("importer", "addBatch", containerId, p.salmonBuyer.address, p.inspector.address, 40, 15, encodeBytes32String(`SAL-${run}`));
  await send("importer", "addBatch", containerId, p.cheeseBuyer.address, p.inspector.address, 80, 15, encodeBytes32String(`CHE-${run}`));
  await setRecording(containerId, 2, "breach"); // the sensor will record a cooling failure on leg 2

  await handover(containerId, "importer", "carrier"); // stage 0: clean dispatch
  await handover(containerId, "carrier", "handler", { tempTenthsC: 34 }, { tempTenthsC: 71, issues: true }); // stage 1
  await sync();
});

test("a failed handover opens a claim at once, while the batch is still in transit", async () => {
  const s = await certificate(salmon);
  assert.deepEqual(
    s.claims.map((c: any) => [c.leg, c.provisionalCustodian, c.reasons]),
    [[1, p.carrier.address, ["receipt_temp", "condition"]]],
  );
  assert.deepEqual(s.stages[1].reasons, ["receipt_temp", "condition"]);
  assert.equal(s.certificate, null, "no certificate yet: the batch is still at the airport");

  // Cheese's limit is 8 °C, so 7.1 °C on receipt isn't a temperature flag, but "accepted with issues" still is.
  assert.deepEqual((await certificate(cheese)).stages[1].reasons, ["condition"]);

  // The carrier sees the claim against them.
  const theirs = await certApi("/claims?status=open", { token: p.carrier.token });
  assert.ok(theirs.body.some((c: any) => c.batchId === salmon && c.leg === 1));

  // QA rules on it now, mid-transit.
  const [claim] = s.claims;
  await assert.rejects(sendCert("otherInspector", "submitResolution", claim.id, Outcome.Upheld, "x"), /not the assigned inspector/);
  await sendCert("inspector", "submitResolution", claim.id, Outcome.Upheld, "Carrier's reefer tripped; their own issue report confirms 25 min unrefrigerated.");
  assert.equal((await certificate(salmon)).claims[0].status, "resolved");
});

test("the rest of the journey: sensor breach on leg 2, damage reported at the cold store, an edited log caught", async () => {
  await handover(containerId, "handler", "coldStore"); // stage 2 checks pass; the sensor will disagree
  await send("coldStore", "splitContainer", containerId);
  await handover(salmon, "coldStore", "truck", { issues: true }); // stage 3: cold store reported damage
  await handover(cheese, "coldStore", "truck");
  await handover(salmon, "truck", "salmonBuyer");
  await handover(cheese, "truck", "cheeseBuyer");

  await upload("carrier", containerId, 1, "compliant");
  await upload("handler", containerId, 2, "breached");
  const edited = await upload("coldStore", containerId, 3, "tampered");
  assert.equal(edited.matches, false, "an edited log doesn't match the sensor's record");
  await upload("coldStore", containerId, 3, "compliant");
  await upload("truck", salmon, 4, "compliant");
  await upload("truck", cheese, 4, "compliant");
  await sync();

  const s = await certificate(salmon);
  assert.equal(s.certificate.status, "flagged");
  assert.deepEqual(
    s.stages.map((st: any) => st.reasons),
    [[], ["receipt_temp", "condition"], ["sensor_excursion"], ["condition"], []],
  );
  // Claims are in the order they opened: stage 3's damage was flagged at the handover, before stage 2's
  // sensor breach (which waited for the log upload). Compare by stage.
  assert.deepEqual(
    [...s.claims].sort((a: any, b: any) => a.leg - b.leg).map((c: any) => [c.leg, c.provisionalCustodian, c.status]),
    [
      [1, p.carrier.address, "resolved"],
      [2, p.handler.address, "open"],
      [3, p.coldStore.address, "open"],
    ],
  );
  const c = await certificate(cheese);
  assert.equal(c.claims.length, 1, "cheese: only the 'accepted with issues' flag at stage 1");
});

test("QA can't decide the batch until every flagged stage is ruled on; the buyer can't close it before QA decides", async () => {
  await assert.rejects(sendCert("salmonBuyer", "acknowledgeReceipt", salmon), /awaiting QA decision/);
  await assert.rejects(sendCert("inspector", "submitDisposition", salmon, Disposition.Rejected, "x"), /rule on every flagged stage first/);

  const claims = (await certificate(salmon)).claims;
  const leg2 = claims.find((c: any) => c.leg === 2);
  const leg3 = claims.find((c: any) => c.leg === 3);
  const note = await certApi(`/claims/${leg2.id}/notes`, { token: p.inspector.token, body: { body: "Handler's log agrees with the sensor." } });
  assert.equal(note.status, 201);
  await sendCert("inspector", "submitResolution", leg2.id, Outcome.CompensationAgreed, "Handler agreed a 10% credit, settled off-platform.");
  await sendCert("inspector", "submitResolution", leg3.id, Outcome.Upheld, "Crushed cartons photographed at pickup.");
  assert.equal((await certificate(salmon)).certificate.status, "resolved");
});

test("QA rejects the salmon and releases the cheese; each buyer closes their batch", async () => {
  await sendCert("inspector", "submitDisposition", salmon, Disposition.Rejected, "Core temperature exceeded 4 °C on two stages; not fit for sale.");
  const [cheeseClaim] = (await certificate(cheese)).claims;
  await sendCert("inspector", "submitResolution", cheeseClaim.id, Outcome.Overturned, "Below the 8 °C limit throughout.");
  await sendCert("inspector", "submitDisposition", cheese, Disposition.Released, "Within limits at every stage.");

  await assert.rejects(sendCert("cheeseBuyer", "acknowledgeReceipt", salmon), /not the batch's buyer/);
  await sendCert("salmonBuyer", "acknowledgeReceipt", salmon);
  await sendCert("cheeseBuyer", "acknowledgeReceipt", cheese);

  const s = await certificate(salmon, "salmonBuyer");
  assert.equal(s.decision.disposition, "rejected");
  assert.equal(s.acknowledgement.buyer, p.salmonBuyer.address);
  assert.equal((await certificate(cheese, "cheeseBuyer")).decision.disposition, "released");
});

test("buyers only see their own certificates", async () => {
  const mine = await certApi("/certificates", { token: p.cheeseBuyer.token });
  assert.deepEqual(
    mine.body.map((b: any) => b.batchId),
    [cheese],
  );
});

test("KPIs and the audit log reflect the checkpoints and QA decisions", async () => {
  const kpis = await certApi("/kpis", { token: admin });
  assert.ok(kpis.body.dispositions.released >= 1 && kpis.body.dispositions.rejected >= 1);
  assert.ok(kpis.body.flagReasons.receipt_temp >= 1 && kpis.body.flagReasons.condition >= 1 && kpis.body.flagReasons.sensor_excursion >= 1);
  assert.ok(kpis.body.checkpoints.completed >= 10);
  assert.equal(kpis.body.claimsByLeg.length, 5);

  const audit = await certApi("/audit?limit=500", { token: admin });
  const events = new Set(audit.body.map((e: any) => e.event));
  for (const name of ["CheckpointRecorded", "ClaimOpened", "LegPassIssued", "EvidenceMismatch", "ResolutionSubmitted", "FinalCertificateIssued", "DispositionSubmitted", "ReceiptAcknowledged"]) {
    assert.ok(events.has(name), `audit log has ${name}`);
  }
  assert.equal((await certApi("/audit", { token: p.inspector.token })).status, 403);
});
