// End-to-end: needs `npm run chain`, `npm run deploy`, and the identity + oracle services running.
//
// The sensor commits what it recorded when each leg ends (compliant unless the admin set "breach"
// beforehand); the custodian who held the leg then uploads their logger file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { adminToken, api, deployed, persona, provider } from "@coldchainsg/common/testing";
import { AUTO_NUMBER, OK_CHECK, SEAL } from "@coldchainsg/common/testing";
import { encodeBytes32String } from "ethers";
import { sha256 } from "../src/replay.ts";

const ORACLE = `http://localhost:${process.env.ORACLE_PORT ?? 4003}`;
const call = api(ORACLE);
const run = Math.random().toString(36).slice(2, 7).toUpperCase(); // sensor ids must be unique per run
const SENSORS = { container: `CTR-${run}`, cold: `B4-${run}`, warm: `B8-${run}` };
const raw = (name: string) => readFileSync(join(import.meta.dirname, "..", "..", "..", "data", "raw", name));

let p: Record<string, Awaited<ReturnType<typeof persona>>>;
let admin: string;
let containerId: number;
let coldBatch: number; // 4.0 °C threshold
let warmBatch: number; // 8.0 °C threshold

const custodyAs = (who: string) => deployed("ShipmentCustody", p[who].signer);
const send = async (who: string, fn: string, ...args: unknown[]) => (await custodyAs(who)[fn](...args)).wait();
const upload = (who: string, shipmentId: number, leg: number, body: object) =>
  call(`/legs/${shipmentId}/${leg}/upload`, { token: p[who].token, body });
const setRecording = (shipmentId: number, leg: number, recording: string) =>
  call(`/legs/${shipmentId}/${leg}/recording`, { method: "PUT", token: admin, body: { recording } });

/** Waits for the sensor loop to commit the leg (it runs every few seconds). */
async function waitForSensor(shipmentId: number, leg: number) {
  const oracle = deployed("SensorOracle", provider);
  for (let i = 0; i < 40; i++) {
    if ((await oracle.committedHash(shipmentId, leg)) !== "0x" + "0".repeat(64)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`sensor never committed shipment ${shipmentId} leg ${leg}`);
}

before(async () => {
  p = {};
  for (const [name, role] of [
    ["supplier", "SUPPLIER"],
    ["carrier", "CARRIER"],
    ["handler", "HANDLER"],
    ["coldStore", "COLD_STORE"],
    ["truck", "TRUCK"],
    ["buyer", "BUYER"],
    ["inspector", "INSPECTOR"],
  ] as const) {
    p[name] = await persona(role);
  }
  admin = await adminToken();
});

test("admin registers sensors; non-admins cannot", async () => {
  for (const [key, sensorId] of Object.entries(SENSORS)) {
    const res = await call("/sensors", { token: admin, body: { sensorId, label: `Logger ${key}` } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const denied = await call("/sensors", { token: p.supplier.token, body: { sensorId: `X-${run}`, label: "x" } });
  assert.equal(denied.status, 403);
  const duplicate = await call("/sensors", { token: admin, body: { sensorId: SENSORS.container, label: "again" } });
  assert.equal(duplicate.status, 400);
});

test("container with a 4 °C and an 8 °C batch; admin sets legs 2 and 3 to record a breach", async () => {
  containerId = Number(await deployed("ShipmentCustody", provider).nextId());
  await send("supplier", "createContainer", encodeBytes32String(SENSORS.container), AUTO_NUMBER);
  coldBatch = containerId + 1;
  warmBatch = containerId + 2;
  await send("supplier", "addBatch", containerId, p.buyer.address, p.inspector.address, 40, 15, encodeBytes32String(SENSORS.cold));
  await send("supplier", "addBatch", containerId, p.buyer.address, p.inspector.address, 80, 15, encodeBytes32String(SENSORS.warm));

  assert.equal((await setRecording(containerId, 2, "breach")).status, 200);
  assert.equal((await setRecording(containerId, 3, "breach")).status, 200);
  assert.equal((await call(`/legs/${containerId}/2/recording`, { method: "PUT", token: p.supplier.token, body: { recording: "compliant" } })).status, 403);

  const legs = (await call("/legs", { token: admin })).body.filter((l: any) => l.shipmentId === containerId);
  assert.deepEqual(
    legs.map((l: any) => [l.leg, l.recording]),
    [
      [1, "compliant"],
      [2, "breach"],
      [3, "breach"],
    ],
  );
});

test("leg 1: the carrier uploads its log at handover; it's checked once the handler accepts", async () => {
  await send("supplier", "recordSeal", containerId, SEAL);
  await send("supplier", "initiateTransfer", containerId, p.carrier.address, OK_CHECK);
  await send("carrier", "acceptTransfer", containerId, OK_CHECK);

  // While the leg is still open, the upload is held, not checked.
  const staged = await upload("carrier", containerId, 1, { demoFile: "compliant" });
  assert.equal(staged.status, 202, JSON.stringify(staged.body));
  assert.equal(staged.body.staged, true);
  assert.equal((await upload("handler", containerId, 1, { demoFile: "compliant" })).status, 403, "not the leg's custodian");
  const bad = await upload("carrier", containerId, 1, { fileBase64: Buffer.from("hello").toString("base64"), fileName: "x.csv" });
  assert.equal(bad.status, 400, "a bad CSV is rejected at upload, not later");

  const mine = (await call("/legs", { token: p.carrier.token })).body;
  assert.deepEqual(
    mine.map((l: any) => [l.shipmentId, l.leg, l.stagedUpload?.fileName]),
    [[containerId, 1, "compliant.csv"]],
    "the carrier sees its log waiting to be checked",
  );

  // The handover ends the leg: the sensor commits, and the held log is checked automatically.
  await send("carrier", "initiateTransfer", containerId, p.handler.address, OK_CHECK);
  await send("handler", "acceptTransfer", containerId, OK_CHECK);
  await waitForSensor(containerId, 1);
  const oracle = deployed("SensorOracle", provider);
  for (let i = 0; i < 40; i++) {
    const statuses = await Promise.all([coldBatch, warmBatch].map(async (b) => (await oracle.getSummary(b, 1)).status));
    if (statuses.every((st) => st === 1n)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const after = (await call("/legs", { token: p.carrier.token })).body.find((l: any) => l.leg === 1);
  assert.deepEqual(after.evidence.map((e: any) => e.status), ["Verified", "Verified"]);
  assert.equal(after.stagedUpload, null);
  assert.equal(after.awaitingUpload, false);

  assert.equal((await upload("carrier", containerId, 1, { demoFile: "compliant" })).status, 409, "already verified");
});

test("leg 2: the handler uploads the genuine breached log; verdict depends on each batch's limit", async () => {
  await send("handler", "initiateTransfer", containerId, p.coldStore.address, OK_CHECK);
  await send("coldStore", "acceptTransfer", containerId, OK_CHECK);
  await waitForSensor(containerId, 2);
  assert.equal((await setRecording(containerId, 2, "compliant")).status, 409, "too late: the sensor has recorded leg 2");

  const res = await upload("handler", containerId, 2, { demoFile: "breached" });
  const [cold, warm] = res.body.results;
  assert.equal(cold.status, "Verified");
  assert.ok(cold.breachMinutes > 15);
  assert.equal(warm.breachMinutes, 0, "8 °C batch never exceeded its limit");
});

test("leg 3: an edited log (from the custodian's computer) is caught; the genuine one is accepted", async () => {
  await send("coldStore", "splitContainer", containerId);
  await waitForSensor(containerId, 3);

  // Uploaded as raw bytes, the way the browser's file picker sends it.
  const edited = await upload("coldStore", containerId, 3, {
    fileBase64: raw("tampered.csv").toString("base64"),
    fileName: "coldstore-log.csv",
  });
  assert.equal(edited.status, 201);
  assert.equal(edited.body.matches, false);
  assert.deepEqual(
    edited.body.results.map((r: any) => r.status),
    ["EvidenceMismatch", "EvidenceMismatch"],
  );
  assert.equal(edited.body.results[0].breachMinutes, 0, "the edit hid the breach, but the hash gives it away");

  const genuine = await upload("coldStore", containerId, 3, { demoFile: "breached" });
  assert.equal(genuine.body.matches, true);
  assert.equal(genuine.body.results[0].status, "Verified");
});

test("bad uploads are rejected", async () => {
  await send("coldStore", "initiateTransfer", coldBatch, p.truck.address, OK_CHECK);
  await send("truck", "acceptTransfer", coldBatch, OK_CHECK);
  await send("truck", "initiateTransfer", coldBatch, p.buyer.address, OK_CHECK);
  await send("buyer", "acceptTransfer", coldBatch, OK_CHECK);
  await waitForSensor(coldBatch, 4);

  const notCsv = await upload("truck", coldBatch, 4, { fileBase64: Buffer.from("hello").toString("base64"), fileName: "x.csv" });
  assert.equal(notCsv.status, 400);
  const notBase64 = await upload("truck", coldBatch, 4, { fileBase64: "***", fileName: "x.csv" });
  assert.equal(notBase64.status, 400);
});

test("leg 4: the truck uploads per batch", async () => {
  const res = await upload("truck", coldBatch, 4, { demoFile: "compliant" });
  assert.deepEqual(
    res.body.results.map((r: any) => [r.batchId, r.status]),
    [[coldBatch, "Verified"]],
  );
});

test("evidence view shows who uploaded each log, and the stored file re-verifies on-chain", async () => {
  const res = await call(`/evidence/${coldBatch}`, { token: p.inspector.token });
  assert.deepEqual(
    res.body.legs.map((l: any) => [l.leg, l.summary?.status]),
    [
      [1, "Verified"],
      [2, "Verified"],
      [3, "Verified"],
      [4, "Verified"],
    ],
  );
  const leg3 = res.body.legs[2];
  assert.equal(leg3.latestUpload.uploadedBy, p.coldStore.address);
  assert.equal(leg3.latestUpload.fileName, "breached.csv");

  const file = await fetch(`${ORACLE}/uploads/${leg3.latestUpload.id}/raw`, {
    headers: { authorization: `Bearer ${p.inspector.token}` },
  });
  const hash = sha256(Buffer.from(await file.arrayBuffer()));
  assert.equal(hash, sha256(raw("breached.csv")));
  assert.equal(await deployed("SensorOracle", provider).verifyFileHash(coldBatch, 3, hash), true);
});
