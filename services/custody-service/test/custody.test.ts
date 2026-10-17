// End-to-end: needs `npm run chain`, `npm run deploy`, and the identity + custody services running.
// Wallets send transactions directly (as MetaMask would); the service stores metadata and serves views.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { api, deployed, persona } from "@coldchainsg/common/testing";
import { AUTO_NUMBER, OK_CHECK, SEAL } from "@coldchainsg/common/testing";
import { encodeBytes32String, id as keccakText } from "ethers";

const call = api(`http://localhost:${process.env.CUSTODY_PORT ?? 4002}`);
const sensor = (id: string) => encodeBytes32String(id);

let p: Record<string, Awaited<ReturnType<typeof persona>>>;
let containerId: number;
let batchIds: number[];

const custodyAs = (who: string) => deployed("ShipmentCustody", p[who].signer);
const send = async (who: string, fn: string, ...args: unknown[]) => {
  const tx = await custodyAs(who)[fn](...args);
  await tx.wait();
  return tx.hash as string;
};

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

test("supplier creates a container and batches, then records their details", async () => {
  const createHash = await send("supplier", "createContainer", sensor("SENS-CTR-7"), AUTO_NUMBER);

  // Someone else can't attach metadata to this supplier's container.
  const hijack = await call("/containers", {
    token: p.otherSupplier.token,
    body: { txHash: createHash, origin: "Fake", departureDate: "2026-10-01" },
  });
  assert.equal(hijack.status, 403);

  const created = await call("/containers", {
    token: p.supplier.token,
    body: { txHash: createHash, origin: "Melbourne, AU", departureDate: "2026-10-01" },
  });
  assert.equal(created.status, 201);
  containerId = created.body.id;

  batchIds = [];
  for (const [buyer, product] of [
    ["buyerA", "Chilled salmon fillets"],
    ["buyerB", "Fresh dairy"],
  ]) {
    const hash = await send(
      "supplier",
      "addBatch",
      containerId,
      p[buyer].address,
      p.inspector.address,
      40,
      15,
      sensor(`SENS-${product.slice(0, 6)}`),
    );
    const res = await call("/batches", { token: p.supplier.token, body: { txHash: hash, product, quantity: 500 } });
    assert.equal(res.status, 201);
    batchIds.push(res.body.id);
  }

  // A tx hash for the wrong event is rejected.
  const wrong = await call("/batches", { token: p.supplier.token, body: { txHash: createHash, product: "X", quantity: 1 } });
  assert.equal(wrong.status, 400);

  const view = await call(`/shipments/${containerId}`, { token: p.supplier.token });
  assert.equal(view.body.stage, "Origin");
  assert.equal(view.body.details.origin, "Melbourne, AU");
  assert.equal(view.body.sensorId, "SENS-CTR-7");
  assert.deepEqual(
    view.body.batches.map((b: any) => [b.details.product, b.thresholdC, b.graceMinutes]),
    [
      ["Chilled salmon fillets", 4, 15],
      ["Fresh dairy", 4, 15],
    ],
  );
});

test("container moves carrier → handler → cold store with two-step handovers", async () => {
  await send("supplier", "recordSeal", containerId, SEAL);
  const sealed = await call(`/shipments/${containerId}`, { token: p.supplier.token });
  assert.match(sealed.body.containerCode, /^CCSU\d{7}$/);
  assert.equal(sealed.body.sealNumber, "SGB4471203");
  for (const [from, to, stage] of [
    ["supplier", "carrier", "Carrier"],
    ["carrier", "handler", "Handler"],
    ["handler", "coldStore", "ColdStore"],
  ]) {
    await send(from, "initiateTransfer", containerId, p[to].address, OK_CHECK);

    // The incoming custodian sees it as pending before accepting.
    const inbox = await call("/shipments", { token: p[to].token });
    assert.equal(inbox.body.find((s: any) => s.id === containerId)?.pendingTo, p[to].address);

    await send(to, "acceptTransfer", containerId, OK_CHECK);
    const view = await call(`/shipments/${containerId}`, { token: p[to].token });
    assert.equal(view.body.stage, stage);
    assert.equal(view.body.custodian, p[to].address);
  }
});

test("a non-custodian's transfer is rejected on-chain", async () => {
  await assert.rejects(send("carrier", "initiateTransfer", containerId, p.truck.address, OK_CHECK), /not the current custodian/);
});

test("cold store splits, each batch goes truck → its own buyer", async () => {
  await send("coldStore", "splitContainer", containerId);
  const [salmon] = batchIds;

  await send("coldStore", "initiateTransfer", salmon, p.truck.address, OK_CHECK);
  await send("truck", "acceptTransfer", salmon, OK_CHECK);
  await assert.rejects(send("truck", "initiateTransfer", salmon, p.buyerB.address, OK_CHECK), /recipient not valid/);
  await send("truck", "initiateTransfer", salmon, p.buyerA.address, OK_CHECK);
  await send("buyerA", "acceptTransfer", salmon, OK_CHECK);

  const view = await call(`/shipments/${salmon}`, { token: p.buyerA.token });
  assert.equal(view.body.stage, "Delivered");
  assert.deepEqual(
    view.body.history.map((h: any) => h.stage),
    ["Origin", "Carrier", "Handler", "ColdStore", "ColdStore", "Truck", "Delivered"],
  );

  // Custodian lookup at the moment the carrier held it.
  const carrierLeg = view.body.history[1];
  const at = await call(`/shipments/${salmon}/custodian-at?at=${carrierLeg.startedAt + 1}`, {
    token: p.buyerA.token,
  });
  assert.equal(at.body.custodian, p.carrier.address);
  assert.equal(at.body.stage, "Carrier");
});

test("each participant only sees shipments they are involved in", async () => {
  const [salmon, dairy] = batchIds;
  const ids = async (who: string) => (await call("/shipments", { token: p[who].token })).body.map((s: any) => s.id);

  assert.deepEqual((await ids("buyerA")).sort(), [salmon]);
  assert.deepEqual((await ids("buyerB")).sort(), [dairy]);
  assert.ok((await ids("inspector")).includes(salmon));
  assert.deepEqual(await ids("otherSupplier"), []);
  assert.equal((await call("/shipments")).status, 401);
});

// ---- Quality checks during a leg and at handover -------------------------------------------

test("only the current holder records readings and issue reports", async () => {
  const sensorId = encodeBytes32String("SENS-Q");
  const id = Number(await deployed("ShipmentCustody", p.supplier.signer).nextId());
  await send("supplier", "createContainer", sensorId, AUTO_NUMBER);
  await send("supplier", "addBatch", id, p.buyerA.address, p.inspector.address, 40, 15, sensorId);
  await send("supplier", "recordSeal", id, SEAL);
  await send("supplier", "initiateTransfer", id, p.carrier.address, OK_CHECK);
  await send("carrier", "acceptTransfer", id, OK_CHECK);

  const r1 = await call(`/shipments/${id}/readings`, { token: p.carrier.token, body: { tempC: 3.2, note: "Hold 2 probe" } });
  assert.equal(r1.status, 201);
  await call(`/shipments/${id}/readings`, { token: p.carrier.token, body: { tempC: 5.8 } });
  const issue = await call(`/shipments/${id}/issues`, {
    token: p.carrier.token,
    body: { category: "refrigeration_failure", unrefrigeratedMinutes: 25, description: "Reefer unit tripped during refuelling stop" },
  });
  assert.equal(issue.status, 201);
  assert.deepEqual(issue.body.digest, { readings: 2, maxTempC: 5.8, issues: 1, unrefrigeratedMinutes: 25 });

  assert.equal((await call(`/shipments/${id}/readings`, { token: p.handler.token, body: { tempC: 3 } })).status, 403);
  assert.equal((await call(`/shipments/${id}/issues`, { token: p.supplier.token, body: { category: "delay", description: "late" } })).status, 403);
  assert.equal((await call(`/shipments/${id}/readings`, { token: p.carrier.token, body: { tempC: 99 } })).status, 400);
  assert.equal(
    (await call(`/shipments/${id}/readings`, { token: p.carrier.token, body: { tempC: 3, takenAt: "2099-01-01T00:00:00Z" } })).status,
    400,
    "no readings in the future",
  );
  (globalThis as any).qualityContainer = id;
});

test("both sides seal their notes; the checkpoint trail shows them, and the hashes match what's on-chain", async () => {
  const id = (globalThis as any).qualityContainer as number;

  // Sender seals readings + issues + note, then signs the outgoing check with that hash.
  const outSeal = await call(`/shipments/${id}/seal`, { token: p.carrier.token, body: { direction: "out", note: "Re-chilled hold after reefer trip" } });
  assert.equal(outSeal.status, 201);
  assert.equal(outSeal.body.snapshot.readings.length, 2);
  assert.equal(outSeal.body.snapshot.issues[0].category, "refrigeration_failure");
  await send("carrier", "initiateTransfer", id, p.handler.address, {
    ...OK_CHECK, tempTenthsC: 52, unrefrigeratedMinutes: 25, issues: true, notesHash: outSeal.body.notesHash,
  });

  // The receiver sees the pending check before deciding.
  const pending = await call(`/shipments/${id}`, { token: p.handler.token });
  assert.equal(pending.body.pendingCheck.tempC, 5.2);
  assert.equal(pending.body.pendingCheck.sealed.note, "Re-chilled hold after reefer trip");

  assert.equal((await call(`/shipments/${id}/seal`, { token: p.coldStore.token, body: { direction: "in", note: "x" } })).status, 403, "not the recipient");
  const inSeal = await call(`/shipments/${id}/seal`, { token: p.handler.token, body: { direction: "in", note: "Cartons warm to the touch" } });
  await send("handler", "acceptTransfer", id, { ...OK_CHECK, tempTenthsC: 71, unrefrigeratedMinutes: 10, issues: true, notesHash: inSeal.body.notesHash });

  const view = await call(`/shipments/${id}`, { token: p.supplier.token });
  const leg1 = view.body.checkpoints.find((c: any) => c.stage === 1);
  assert.equal(leg1.outgoing.by, p.carrier.address);
  assert.equal(leg1.outgoing.tempC, 5.2);
  assert.equal(leg1.incoming.by, p.handler.address);
  assert.equal(leg1.incoming.tempC, 7.1);
  assert.equal(leg1.incoming.sealed.note, "Cartons warm to the touch");
  // Anyone can re-hash the stored snapshot and compare it with the on-chain hash.
  assert.equal(keccakText(JSON.stringify(leg1.outgoing.sealed)), leg1.outgoing.notesHash);
  assert.equal(keccakText(JSON.stringify(leg1.incoming.sealed)), leg1.incoming.notesHash);

  const origin = view.body.checkpoints.find((c: any) => c.stage === 0);
  assert.equal(origin.incoming.by, p.carrier.address);
  assert.equal(view.body.checkpoints.find((c: any) => c.stage === 2).incoming, null, "not handed over yet");
});
