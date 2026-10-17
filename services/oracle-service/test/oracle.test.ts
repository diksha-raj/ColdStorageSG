// End-to-end: needs the chain, a deployment, and the identity, sensor gateway and oracle services.
//
// Each party registers its own sensor with the gateway (a demo sensor, or its own with an export
// attached), then on-chain. When a stage's window closes, the sensor commits its readings; the
// oracle summarises them for each batch against the batch's own limit.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { db } from "@coldchainsg/common";
import { AUTO_NUMBER, OK_CHECK, SEAL, api, deployed, persona, provider } from "@coldchainsg/common/testing";
import { ZeroHash, encodeBytes32String } from "ethers";
import { sha256 } from "../src/summary.ts";

const oracleApi = api(`http://localhost:${process.env.ORACLE_PORT ?? 4003}`);
const gatewayApi = api(`http://localhost:${process.env.GATEWAY_PORT ?? 4005}`);
const STATUS = ["None", "Verified", "EvidenceMismatch"];

let p: Record<string, Awaited<ReturnType<typeof persona>>>;
let salmon: number; // limit 4.0 °C
let cheese: number; // limit 8.0 °C
let container: number;

const send = async (who: string, fn: string, ...args: unknown[]) => (await deployed("ShipmentCustody", p[who].signer)[fn](...args)).wait();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Moves the test chain's clock on, instead of waiting. */
const travel = async (seconds: number) => {
  const latest = (await provider.getBlock("latest"))!.timestamp;
  await provider.send("evm_setNextBlockTimestamp", [latest + seconds]);
  await provider.send("evm_mine", []);
};
const oracle = () => deployed("SensorOracle", provider);

/** Registers a sensor with the gateway, then on-chain against the units, as the dashboard does. */
async function registerSensor(who: string, ids: number[], body: object) {
  const res = await gatewayApi("/sensors", { token: p[who].token, body });
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
  await send(who, "registerSensor", ids, encodeBytes32String(res.body.sensorId), res.body.device);
  return res.body;
}

/** A sensor export: 3 °C, then 6.5 °C for minutes 3-24 (above 4 °C, below 8 °C), then 3 °C. */
const EXCURSION_EXPORT =
  "timestamp,temperature_c\n" +
  Array.from({ length: 40 }, (_, m) => `${new Date(Date.UTC(2026, 9, 1, 6, m)).toISOString()},${m >= 3 && m <= 24 ? 6.5 : 3.0}`).join("\n");

async function waitForSummary(batchId: number, stage: number) {
  for (let i = 0; i < 80; i++) {
    const s = await oracle().getSummary(batchId, stage);
    if (Number(s.status) !== 0) return s;
    await pause(250);
  }
  throw new Error(`no summary for batch ${batchId} stage ${stage}`);
}

before(async () => {
  p = {};
  for (const [name, role] of [
    ["supplier", "SUPPLIER"],
    ["otherTruck", "TRUCK"],
    ["carrier", "CARRIER"],
    ["handler", "HANDLER"],
    ["coldStore", "COLD_STORE"],
    ["truck", "TRUCK"],
    ["buyer", "BUYER"],
    ["inspector", "INSPECTOR"],
  ] as const) {
    p[name] = await persona(role);
  }
});

test("participants register their own sensors with the gateway; the handler and outsiders can't", async () => {
  const demo = await gatewayApi("/sensors", { token: p.supplier.token, body: { mode: "compliant" } });
  assert.equal(demo.status, 201);
  assert.match(demo.body.sensorId, /^SIM-SUP-[0-9A-F]{4}$/);
  assert.match(demo.body.device, /^0x[0-9a-fA-F]{40}$/);
  assert.ok((await provider.getBalance(demo.body.device)) > 0n, "the gateway funds the device key");

  assert.equal((await gatewayApi("/sensors", { token: p.handler.token, body: { mode: "compliant" } })).status, 403, "the container's sensor covers the handler");
  assert.equal((await gatewayApi("/sensors", { body: { mode: "compliant" } })).status, 401);
  assert.equal((await gatewayApi("/sensors", { token: p.truck.token, body: { mode: "feed", sensorId: "TRUCK-7" } })).status, 400, "an own sensor needs its export");
  assert.equal(
    (await gatewayApi("/sensors", { token: p.truck.token, body: { mode: "feed", sensorId: "TRUCK-7", feedCsv: "timestamp,temperature_c\nnope,3\n" } })).status,
    400,
  );

  const own = `TRK-${Date.now().toString(36).toUpperCase()}`;
  const first = await gatewayApi("/sensors", { token: p.truck.token, body: { mode: "feed", sensorId: own, feedCsv: EXCURSION_EXPORT } });
  assert.equal(first.status, 201);
  assert.equal(first.body.mode, "feed");
  assert.equal((await gatewayApi("/sensors", { token: p.otherTruck.token, body: { mode: "feed", sensorId: own, feedCsv: EXCURSION_EXPORT } })).status, 409);
  const mine = await gatewayApi("/sensors/mine", { token: p.truck.token });
  assert.ok(mine.body.some((s: any) => s.sensorId === own));
});

test("a journey with a sensor at every stage: each stage's readings are committed by its sensor and summarised per batch", async () => {
  const custody = deployed("ShipmentCustody", provider);
  salmon = Number(await custody.nextId());
  await send("supplier", "createBatch", p.buyer.address, p.inspector.address, 40, 15);
  cheese = salmon + 1;
  await send("supplier", "createBatch", p.buyer.address, p.inspector.address, 80, 15);
  await registerSensor("supplier", [salmon, cheese], { mode: "compliant" });

  container = cheese + 1;
  await send("carrier", "createContainer", AUTO_NUMBER);
  await registerSensor("carrier", [container], { mode: "compliant" });
  for (const b of [salmon, cheese]) {
    await send("supplier", "initiateTransfer", b, p.carrier.address, OK_CHECK);
    await send("carrier", "acceptIntoContainer", b, container, OK_CHECK);
  }
  await send("carrier", "recordSeal", container, SEAL);
  await send("carrier", "initiateTransfer", container, p.handler.address, OK_CHECK);
  await send("handler", "acceptTransfer", container, OK_CHECK);
  await send("handler", "initiateTransfer", container, p.coldStore.address, OK_CHECK);
  await send("coldStore", "acceptTransfer", container, OK_CHECK);
  await registerSensor("coldStore", [salmon, cheese], { mode: "compliant" });
  await send("coldStore", "unloadContainer", container);
  for (const b of [salmon, cheese]) {
    await send("coldStore", "initiateTransfer", b, p.truck.address, OK_CHECK);
    await send("truck", "acceptTransfer", b, OK_CHECK);
  }
  // The truck's own sensor, fed from its export: a 6.5 °C excursion from minute 3 to 24.
  const truckSensor = `TRK2-${Date.now().toString(36).toUpperCase()}`;
  await registerSensor("truck", [salmon, cheese], { mode: "feed", sensorId: truckSensor, feedCsv: EXCURSION_EXPORT });
  await travel(27 * 60); // 27 minutes on the road
  for (const b of [salmon, cheese]) {
    await send("truck", "initiateTransfer", b, p.buyer.address, OK_CHECK);
    await send("buyer", "acceptTransfer", b, OK_CHECK);
  }

  for (const b of [salmon, cheese]) {
    for (const stage of [0, 1, 2, 3]) {
      const s = await waitForSummary(b, stage);
      assert.equal(STATUS[Number(s.status)], "Verified", `batch ${b} stage ${stage}`);
      assert.equal(s.breachMinutes, 0n);
      assert.equal(s.missingMinutes, 0n, `batch ${b} stage ${stage} has a reading every minute`);
    }
  }
  // Container stages are committed once, on the container.
  assert.notEqual(await oracle().committedHash(container, 1), ZeroHash);
  assert.equal(await oracle().committedHash(salmon, 1), ZeroHash);

  // Same truck readings, judged against each batch's own limit.
  const salmonTruck = await waitForSummary(salmon, 4);
  const cheeseTruck = await waitForSummary(cheese, 4);
  assert.ok(Number(salmonTruck.breachMinutes) > 15, `salmon breach ${salmonTruck.breachMinutes} min`);
  assert.equal(Number(salmonTruck.maxTenthsC), 65);
  assert.equal(cheeseTruck.breachMinutes, 0n, "6.5 °C is within the cheese's 8 °C limit");
});

test("demo sensors follow each batch's own spec: a frozen batch's room holds below -18 °C, and a failure breaches it", async () => {
  const custody = deployed("ShipmentCustody", provider);
  const peas = Number(await custody.nextId());
  await send("supplier", "createBatch", p.buyer.address, p.inspector.address, -180, 5); // frozen peas, ≤ -18 °C
  await registerSensor("supplier", [peas], { mode: "compliant" });
  const box = peas + 1;
  await send("carrier", "createContainer", AUTO_NUMBER);
  await registerSensor("carrier", [box], { mode: "breached" });
  await travel(30);
  await send("supplier", "initiateTransfer", peas, p.carrier.address, OK_CHECK);
  await send("carrier", "acceptIntoContainer", peas, box, OK_CHECK);
  await travel(12 * 60); // the container's refrigeration fails a minute in
  await send("carrier", "recordSeal", box, SEAL);
  await send("carrier", "initiateTransfer", box, p.handler.address, OK_CHECK);
  await send("handler", "acceptTransfer", box, OK_CHECK);

  const room = await waitForSummary(peas, 0);
  assert.ok(Number(room.maxTenthsC) < -180, `the supplier's room peaked at ${Number(room.maxTenthsC) / 10} °C`);
  assert.equal(room.breachMinutes, 0n);
  const container = await waitForSummary(peas, 1);
  assert.ok(Number(container.maxTenthsC) > -180 + 45, `the failed container reached ${Number(container.maxTenthsC) / 10} °C`);
  assert.ok(Number(container.breachMinutes) > 5, `${container.breachMinutes} min above -18 °C`);
});

test("the evidence view: per stage, the sensor, its readings, the summary, and the handover gap that followed", async () => {
  const res = await oracleApi(`/evidence/${salmon}`); // public, like the certificate it backs
  assert.equal(res.status, 200);
  const { stages, thresholdC } = res.body;
  assert.equal(thresholdC, 4);
  assert.deepEqual(stages.map((s: any) => s.sensor?.mode), ["compliant", "compliant", "compliant", "compliant", "feed"]);
  assert.equal(stages[1].sensor.sensorId, stages[2].sensor.sensorId, "the container's sensor covers stages 1 and 2");
  for (const s of stages) {
    // A sensor reads every 10 seconds (a feed once a minute): a stage shorter than that may have none.
    assert.ok(s.readings.length > 0 || s.end - s.start < 60, `stage ${s.stage} has readings`);
    assert.ok(s.readings.every((r: any) => r.at >= s.start && r.at <= s.end), `stage ${s.stage} readings sit inside its window`);
    assert.equal(s.committed.matchesChain, true);
  }
  assert.equal(stages[1].gap, null, "no gap: the container's sensor keeps reading through that handover");
  for (const i of [0, 2, 3, 4]) {
    assert.ok(stages[i].gap.to >= stages[i].gap.from, `stage ${i} gap runs from sign-off to sign-in`);
  }
  assert.equal(stages[4].summary.maxC, 6.5);
});

test("the committed file is public; anyone can re-hash it, and an altered copy no longer matches", async () => {
  const log = await gatewayApi(`/logs/${container}/1`);
  assert.equal(log.status, 200);
  assert.equal(sha256(log.body.csv), await oracle().committedHash(container, 1));
  assert.equal(await oracle().verifyFileHash(salmon, 1, sha256(log.body.csv)), true);

  // Someone edits a stored reading after the sensor committed it.
  const edited = log.body.csv.replace(/(\n[^,\n]+,)[-\d.]+/, "$1-1.0"); // the first reading, changed
  await db.query("UPDATE gateway.commits SET csv = $1 WHERE unit_id = $2 AND stage = 1", [edited, container]);
  assert.equal(await oracle().verifyFileHash(salmon, 1, sha256(edited)), false);
  const evidence = await oracleApi(`/evidence/${salmon}`);
  assert.equal(evidence.body.stages[1].committed.matchesChain, false, "the evidence view shows the mismatch");
  await db.query("UPDATE gateway.commits SET csv = $1 WHERE unit_id = $2 AND stage = 1", [log.body.csv, container]);
  await db.end();
});
