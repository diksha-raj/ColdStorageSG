// End-to-end: needs `npm run chain`, `npm run deploy`, and the identity + custody services running.
// Wallets send transactions directly (as MetaMask would); the service stores metadata and serves views.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { AUTO_NUMBER, OK_CHECK, SEAL, api, deployed, persona } from "@coldchainsg/common/testing";
import { encodeBytes32String, id as keccakText } from "ethers";

const call = api(`http://localhost:${process.env.CUSTODY_PORT ?? 4002}`);
const run = Date.now().toString(36).toUpperCase();
const sensorId = (name: string) => encodeBytes32String(`${name}-${run}`);

let p: Record<string, Awaited<ReturnType<typeof persona>>>;
let salmon: number;
let dairy: number;
let containerId: number;

const custodyAs = (who: string) => deployed("ShipmentCustody", p[who].signer);
const send = async (who: string, fn: string, ...args: unknown[]) => {
  const tx = await custodyAs(who)[fn](...args);
  await tx.wait();
  return tx.hash as string;
};
/** A party registers its own sensor for the units it holds (any device key will do here). */
const registerSensor = (who: string, ids: number[], name: string) => send(who, "registerSensor", ids, sensorId(name), p[who].address);

before(async () => {
  p = {};
  for (const [name, role] of [
    ["supplier", "SUPPLIER"],
    ["otherSupplier", "SUPPLIER"],
    ["carrier", "CARRIER"],
    ["handler", "HANDLER"],
    ["coldStore", "COLD_STORE"],
    ["truck", "TRUCK"],
    ["buyerA", "BUYER"],
    ["buyerB", "BUYER"],
    ["inspector", "INSPECTOR"],
  ] as const) {
    p[name] = await persona(role);
  }
});

test("the supplier creates batches with their limits and records their details", async () => {
  const ids: number[] = [];
  let firstHash = "";
  for (const [buyer, product] of [
    ["buyerA", "Chilled salmon fillets"],
    ["buyerB", "Fresh dairy"],
  ]) {
    const hash = await send("supplier", "createBatch", p[buyer].address, p.inspector.address, 40, 15);
    firstHash ||= hash;
    // Someone else can't attach details to this supplier's batch.
    assert.equal((await call("/batches", { token: p.otherSupplier.token, body: { txHash: hash, product: "Fake", quantity: 1 } })).status, 403);
    const res = await call("/batches", { token: p.supplier.token, body: { txHash: hash, product, quantity: 500 } });
    assert.equal(res.status, 201);
    ids.push(res.body.id);
  }
  [salmon, dairy] = ids;
  await registerSensor("supplier", ids, "SUP-ROOM");

  const view = await call(`/shipments/${salmon}`, { token: p.supplier.token });
  assert.equal(view.body.stage, "Origin");
  assert.equal(view.body.supplier, p.supplier.address);
  assert.equal(view.body.details.product, "Chilled salmon fillets");
  assert.equal(view.body.containerId, null, "not in a container yet");
  assert.deepEqual(view.body.sensors.map((s: any) => [s.stage, s.sensorId]), [[0, `SUP-ROOM-${run}`]]);
  assert.equal((await call("/containers", { token: p.carrier.token, body: { txHash: firstHash, mode: "sea", voyage: "X", origin: "AA", destination: "BB", departureDate: "2026-10-01" } })).status, 400, "wrong event");
});

test("Cargo opens a container and receives each batch straight into it", async () => {
  const createHash = await send("carrier", "createContainer", AUTO_NUMBER);
  const created = await call("/containers", {
    token: p.carrier.token,
    body: { txHash: createHash, mode: "sea", voyage: "MSC AURORA 041E", origin: "Melbourne, AU", destination: "Singapore", departureDate: "2026-10-01" },
  });
  assert.equal(created.status, 201);
  containerId = created.body.id;
  await registerSensor("carrier", [containerId], "CTR-REEFER");

  for (const batch of [salmon, dairy]) {
    await send("supplier", "initiateTransfer", batch, p.carrier.address, OK_CHECK);
    // Cargo sees it coming before signing it in.
    const inbox = await call("/shipments", { token: p.carrier.token });
    assert.equal(inbox.body.find((s: any) => s.id === batch)?.pendingTo, p.carrier.address);
    await send("carrier", "acceptIntoContainer", batch, containerId, OK_CHECK);
  }

  const box = await call(`/shipments/${containerId}`, { token: p.carrier.token });
  assert.equal(box.body.kind, "container");
  assert.match(box.body.containerCode, /^CCSU\d{7}$/);
  assert.deepEqual([box.body.details.mode, box.body.details.voyage, box.body.details.destination], ["sea", "MSC AURORA 041E", "Singapore"]);
  assert.deepEqual(box.body.batches.map((b: any) => b.details.product), ["Chilled salmon fillets", "Fresh dairy"]);

  const batch = await call(`/shipments/${salmon}`, { token: p.buyerA.token });
  assert.equal(batch.body.containerId, containerId);
  assert.equal(batch.body.containerCode, box.body.containerCode);
  assert.equal(batch.body.inContainer, true);
  assert.equal(batch.body.custodian, p.carrier.address);
  assert.equal(batch.body.checkpoints.find((c: any) => c.stage === 0).incoming.by, p.carrier.address);
});

test("the sealed container travels with its batches; the cold store unloads them; each goes to its buyer", async () => {
  await send("carrier", "recordSeal", containerId, SEAL);
  await send("carrier", "initiateTransfer", containerId, p.handler.address, OK_CHECK);
  await send("handler", "acceptTransfer", containerId, OK_CHECK);
  await send("handler", "initiateTransfer", containerId, p.coldStore.address, OK_CHECK);
  await send("coldStore", "acceptTransfer", containerId, OK_CHECK);

  const atStore = await call(`/shipments/${salmon}`, { token: p.buyerA.token });
  assert.equal(atStore.body.stage, "ColdStore");
  assert.equal(atStore.body.sealNumber, "SGB4471203", "a batch shows its container's seal");

  await registerSensor("coldStore", [salmon, dairy], "COLD-ROOM");
  await assert.rejects(send("coldStore", "initiateTransfer", salmon, p.truck.address, OK_CHECK), /batch is inside a container/);
  await send("coldStore", "unloadContainer", containerId);
  await send("coldStore", "initiateTransfer", salmon, p.truck.address, OK_CHECK);
  await send("truck", "acceptTransfer", salmon, OK_CHECK);
  await registerSensor("truck", [salmon], "TRUCK");
  await assert.rejects(send("truck", "initiateTransfer", salmon, p.buyerB.address, OK_CHECK), /recipient not valid/);
  await send("truck", "initiateTransfer", salmon, p.buyerA.address, OK_CHECK);
  await send("buyerA", "acceptTransfer", salmon, OK_CHECK);

  const view = await call(`/shipments/${salmon}`, { token: p.buyerA.token });
  assert.equal(view.body.stage, "Delivered");
  assert.equal(view.body.inContainer, false);
  assert.deepEqual(view.body.history.map((h: any) => h.stage), ["Origin", "Carrier", "Handler", "ColdStore", "Truck", "Delivered"]);
  assert.deepEqual(
    view.body.sensors.map((s: any) => [s.stage, s.sensorId]),
    [
      [0, `SUP-ROOM-${run}`],
      [1, `CTR-REEFER-${run}`],
      [2, `CTR-REEFER-${run}`],
      [3, `COLD-ROOM-${run}`],
      [4, `TRUCK-${run}`],
    ],
  );
});

test("each participant sees what they supplied, hold, held, buy or inspect", async () => {
  const ids = async (who: string) => (await call("/shipments", { token: p[who].token })).body.map((s: any) => s.id);
  assert.deepEqual(await ids("buyerA"), [salmon]);
  assert.deepEqual(await ids("buyerB"), [dairy]);
  assert.deepEqual((await ids("carrier")).sort(), [salmon, dairy, containerId].sort(), "Cargo still sees what it carried");
  assert.ok((await ids("inspector")).includes(salmon));
  assert.deepEqual(await ids("otherSupplier"), []);
  assert.equal((await call("/shipments")).status, 401);
});

// ---- Quality checks during a stage and at handover -------------------------------------------

let qualityBox: number;

test("only the current holder records readings and issue reports", async () => {
  const batch = Number(await deployed("ShipmentCustody", p.supplier.signer).nextId());
  await send("supplier", "createBatch", p.buyerA.address, p.inspector.address, 40, 15);
  await registerSensor("supplier", [batch], "SUP-ROOM");
  qualityBox = batch + 1;
  await send("carrier", "createContainer", AUTO_NUMBER);
  await registerSensor("carrier", [qualityBox], "CTR-REEFER-2");
  await send("supplier", "initiateTransfer", batch, p.carrier.address, OK_CHECK);
  await send("carrier", "acceptIntoContainer", batch, qualityBox, OK_CHECK);

  const r1 = await call(`/shipments/${qualityBox}/readings`, { token: p.carrier.token, body: { tempC: 3.2, note: "Hold 2 probe" } });
  assert.equal(r1.status, 201);
  await call(`/shipments/${qualityBox}/readings`, { token: p.carrier.token, body: { tempC: 5.8 } });
  const issue = await call(`/shipments/${qualityBox}/issues`, {
    token: p.carrier.token,
    body: { category: "refrigeration_failure", unrefrigeratedMinutes: 25, description: "Reefer unit tripped during refuelling stop" },
  });
  assert.equal(issue.status, 201);
  assert.deepEqual(issue.body.digest, { readings: 2, maxTempC: 5.8, issues: 1, unrefrigeratedMinutes: 25 });

  assert.equal((await call(`/shipments/${qualityBox}/readings`, { token: p.handler.token, body: { tempC: 3 } })).status, 403);
  assert.equal((await call(`/shipments/${qualityBox}/issues`, { token: p.supplier.token, body: { category: "delay", description: "late" } })).status, 403);
  assert.equal((await call(`/shipments/${qualityBox}/readings`, { token: p.carrier.token, body: { tempC: 99 } })).status, 400);
  assert.equal(
    (await call(`/shipments/${qualityBox}/readings`, { token: p.carrier.token, body: { tempC: 3, takenAt: "2099-01-01T00:00:00Z" } })).status,
    400,
    "no readings in the future",
  );
});

test("both sides seal their notes; the checkpoint trail shows them, and the hashes match what's on-chain", async () => {
  const id = qualityBox;
  await send("carrier", "recordSeal", id, SEAL);

  // Sender seals readings + issues + note, then signs the outgoing check with that hash.
  const outSeal = await call(`/shipments/${id}/seal`, { token: p.carrier.token, body: { direction: "out", note: "Re-chilled hold after reefer trip" } });
  assert.equal(outSeal.status, 201);
  assert.equal(outSeal.body.snapshot.readings.length, 2);
  assert.equal(outSeal.body.snapshot.issues[0].category, "refrigeration_failure");
  await send("carrier", "initiateTransfer", id, p.handler.address, { ...OK_CHECK, tempTenthsC: 52, issues: true, notesHash: outSeal.body.notesHash });

  // The receiver sees the pending check before deciding.
  const pending = await call(`/shipments/${id}`, { token: p.handler.token });
  assert.equal(pending.body.pendingCheck.tempC, 5.2);
  assert.equal(pending.body.pendingCheck.sealed.note, "Re-chilled hold after reefer trip");

  assert.equal((await call(`/shipments/${id}/seal`, { token: p.coldStore.token, body: { direction: "in", note: "x" } })).status, 403, "not the recipient");
  const inSeal = await call(`/shipments/${id}/seal`, { token: p.handler.token, body: { direction: "in", note: "Cartons warm to the touch" } });
  await send("handler", "acceptTransfer", id, { ...OK_CHECK, tempTenthsC: 71, issues: true, notesHash: inSeal.body.notesHash });

  const view = await call(`/shipments/${id}`, { token: p.carrier.token });
  const stage1 = view.body.checkpoints.find((c: any) => c.stage === 1);
  assert.equal(stage1.outgoing.by, p.carrier.address);
  assert.equal(stage1.outgoing.tempC, 5.2);
  assert.equal(stage1.incoming.by, p.handler.address);
  assert.equal(stage1.incoming.tempC, 7.1);
  assert.equal(stage1.incoming.sealed.note, "Cartons warm to the touch");
  // Anyone can re-hash the stored snapshot and compare it with the on-chain hash.
  assert.equal(keccakText(JSON.stringify(stage1.outgoing.sealed)), stage1.outgoing.notesHash);
  assert.equal(keccakText(JSON.stringify(stage1.incoming.sealed)), stage1.incoming.notesHash);
  assert.equal(view.body.checkpoints.find((c: any) => c.stage === 2).incoming, null, "not handed over yet");
});
