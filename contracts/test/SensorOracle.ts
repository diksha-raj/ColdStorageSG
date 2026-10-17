import { expect } from "chai";
import { network } from "hardhat";
import { deploy } from "./fixtures.ts";

const { ethers } = await network.create();

const GENUINE = ethers.sha256(ethers.toUtf8Bytes("genuine readings"));
const TAMPERED = ethers.sha256(ethers.toUtf8Bytes("edited readings"));
const Status = { None: 0n, Verified: 1n, EvidenceMismatch: 2n };

describe("SensorOracle", function () {
  /** One batch received into a container by Cargo: stage 0 has ended, stage 1 is in progress. */
  async function setup() {
    const f = await deploy(ethers);
    const batch = await f.newBatch();
    const container = await f.newContainer();
    await f.toCargo(batch, container);
    const submit = (signer: typeof f.oracle, stage: number, hash: string, unit = batch) =>
      f.sensors.connect(signer).submitLegSummary(unit, stage, hash, 21, 35, 0, 0, 0, 0);
    return { ...f, batch, container, submit };
  }

  describe("sensor commits", function () {
    it("only the sensor registered for that unit and stage can commit its readings", async function () {
      const { sensors, stranger, oracle, batch } = await setup();
      await expect(sensors.connect(stranger).commitFileHash(batch, 0, GENUINE)).to.be.revertedWith(
        "not the registered sensor for this stage",
      );
      await expect(sensors.connect(oracle).commitFileHash(batch, 0, GENUINE)).to.be.revertedWith(
        "not the registered sensor for this stage",
      );
    });

    it("a sensor commits once its window has closed, once", async function () {
      const { sensors, device, SENSOR, batch, container, toHandler } = await setup();
      await expect(sensors.connect(device).commitFileHash(container, 1, GENUINE)).to.be.revertedWith("stage not finished");

      await expect(sensors.connect(device).commitFileHash(batch, 0, GENUINE))
        .to.emit(sensors, "FileHashCommitted")
        .withArgs(batch, 0, SENSOR.supplier, GENUINE);
      await expect(sensors.connect(device).commitFileHash(batch, 0, TAMPERED)).to.be.revertedWith("stage already committed");

      // The container's stage-1 window closes when the handler signs the container in.
      await toHandler(container);
      await sensors.connect(device).commitFileHash(container, 1, GENUINE);
      expect(await sensors.committedHash(container, 1)).to.equal(GENUINE);
    });

    it("container stages are committed on the container, not on a batch inside it", async function () {
      const { sensors, device, batch, container, toHandler } = await setup();
      await toHandler(container);
      await expect(sensors.connect(device).commitFileHash(batch, 1, GENUINE)).to.be.revertedWith("stage is recorded on the container");
    });
  });

  describe("per-batch summaries", function () {
    it("REJECTS a summary from anyone but a registered oracle", async function () {
      const { sensors, device, stranger, batch, submit } = await setup();
      await sensors.connect(device).commitFileHash(batch, 0, GENUINE);
      await expect(submit(stranger, 0, GENUINE)).to.be.revertedWith("not a registered oracle");
    });

    it("needs the sensor's commit first, and is per batch", async function () {
      const { oracle, container, submit } = await setup();
      await expect(submit(oracle, 0, GENUINE)).to.be.revertedWith("sensor has not committed this stage");
      await expect(submit(oracle, 1, GENUINE, container)).to.be.revertedWith("not a batch");
    });

    it("a matching hash is Verified and the summary is stored, including minutes with no readings", async function () {
      const { sensors, device, oracle, batch } = await setup();
      await sensors.connect(device).commitFileHash(batch, 0, GENUINE);
      await expect(sensors.connect(oracle).submitLegSummary(batch, 0, GENUINE, 18, 72, 42, 5, 1000, 3520))
        .to.emit(sensors, "LegSummarySubmitted")
        .withArgs(batch, 0, GENUINE, Status.Verified);
      const s = await sensors.getSummary(batch, 0);
      expect(s.status).to.equal(Status.Verified);
      expect(s.maxTenthsC).to.equal(72n);
      expect(s.breachMinutes).to.equal(42n);
      expect(s.missingMinutes).to.equal(5n);
      expect(s.breachStart).to.equal(1000n);
    });

    it("a batch inside a container is summarised against the container's commit", async function () {
      const { sensors, device, oracle, batch, container, toHandler, submit } = await setup();
      await toHandler(container);
      await sensors.connect(device).commitFileHash(container, 1, GENUINE);
      await submit(oracle, 1, GENUINE);
      expect((await sensors.getSummary(batch, 1)).status).to.equal(Status.Verified);
      expect(await sensors.verifyFileHash(batch, 1, GENUINE)).to.equal(true);
    });

    it("REJECTS submitting a verified stage twice", async function () {
      const { sensors, device, oracle, batch, submit } = await setup();
      await sensors.connect(device).commitFileHash(batch, 0, GENUINE);
      await submit(oracle, 0, GENUINE);
      await expect(submit(oracle, 0, GENUINE)).to.be.revertedWith("stage already submitted");
    });

    it("readings altered after the commit are marked EvidenceMismatch; the genuine ones can replace them", async function () {
      const { sensors, device, oracle, batch, submit } = await setup();
      await sensors.connect(device).commitFileHash(batch, 0, GENUINE);
      await expect(submit(oracle, 0, TAMPERED)).to.emit(sensors, "EvidenceMismatch").withArgs(batch, 0, GENUINE, TAMPERED);
      expect((await sensors.getSummary(batch, 0)).status).to.equal(Status.EvidenceMismatch);
      await submit(oracle, 0, GENUINE);
      expect((await sensors.getSummary(batch, 0)).status).to.equal(Status.Verified);
    });

    it("rejects inconsistent summaries", async function () {
      const { sensors, device, oracle, batch } = await setup();
      await sensors.connect(device).commitFileHash(batch, 0, GENUINE);
      await expect(sensors.connect(oracle).submitLegSummary(batch, 0, GENUINE, 50, 20, 0, 0, 0, 0)).to.be.revertedWith("min above max");
      await expect(sensors.connect(oracle).submitLegSummary(batch, 0, GENUINE, 20, 50, 5, 0, 900, 100)).to.be.revertedWith(
        "breach ends before it starts",
      );
    });
  });

  it("anyone can check a readings file against the sensor's commit", async function () {
    const { sensors, device, batch } = await setup();
    expect(await sensors.verifyFileHash(batch, 0, GENUINE)).to.equal(false, "nothing committed yet");
    await sensors.connect(device).commitFileHash(batch, 0, GENUINE);
    expect(await sensors.verifyFileHash(batch, 0, GENUINE)).to.equal(true);
    expect(await sensors.verifyFileHash(batch, 0, TAMPERED)).to.equal(false);
  });

  it("everything stops while paused", async function () {
    const { registry, sensors, device, batch } = await setup();
    await registry.pause();
    await expect(sensors.connect(device).commitFileHash(batch, 0, GENUINE)).to.be.revertedWith("system paused");
  });
});
