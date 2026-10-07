import { expect } from "chai";
import { network } from "hardhat";

/** A passing quality check: 3.0 °C, nothing unrefrigerated, sealed, no issues. */
const OK = { tempTenthsC: 30, unrefrigeratedMinutes: 0, damaged: false, sealIntact: true, issues: false, notesHash: "0x" + "0".repeat(64) };

const { ethers } = await network.create();

const role = (name: string) => ethers.id(name);
const bytes32 = (s: string) => ethers.encodeBytes32String(s);
const CTR_SENSOR = bytes32("SENS-CTR");
const BATCH_SENSOR = bytes32("SENS-B1");
const GENUINE = ethers.sha256(ethers.toUtf8Bytes("genuine csv"));
const TAMPERED = ethers.sha256(ethers.toUtf8Bytes("tampered csv"));
const Status = { None: 0n, Verified: 1n, EvidenceMismatch: 2n };

describe("SensorOracle", function () {
  /** Container 1 with batch 2, moved to the carrier (leg 1 in progress). */
  async function deploy() {
    const [admin, oracle, device, importer, carrier, handler, coldStore, truck, buyer, inspector, stranger] =
      await ethers.getSigners();
    const registry = await ethers.deployContract("ParticipantRegistry", [admin.address]);
    const custody = await ethers.deployContract("ShipmentCustody", [await registry.getAddress()]);
    const sensors = await ethers.deployContract("SensorOracle", [
      await registry.getAddress(),
      await custody.getAddress(),
    ]);

    for (const [s, r] of [
      [oracle, "ORACLE"],
      [importer, "IMPORTER"],
      [carrier, "CARRIER"],
      [handler, "HANDLER"],
      [coldStore, "COLD_STORE"],
      [truck, "TRUCK"],
      [buyer, "BUYER"],
      [inspector, "INSPECTOR"],
    ] as const) {
      await registry.registerParticipant(s.address, role(r));
    }
    await sensors.registerSensor(CTR_SENSOR, device.address);
    await sensors.registerSensor(BATCH_SENSOR, device.address);

    await custody.connect(importer).createContainer(CTR_SENSOR);
    await custody.connect(importer).addBatch(1, buyer.address, inspector.address, 40, 15, BATCH_SENSOR);
    await custody.connect(importer).initiateTransfer(1, carrier.address, OK);
    await custody.connect(carrier).acceptTransfer(1, OK);

    /** Ends leg 1 by handing the container to the handler. */
    const finishLeg1 = async () => {
      await custody.connect(carrier).initiateTransfer(1, handler.address, OK);
      await custody.connect(handler).acceptTransfer(1, OK);
    };

    const submit = (signer: typeof oracle, batchId: number, leg: number, hash: string) =>
      sensors.connect(signer).submitLegSummary(batchId, leg, hash, 21, 35, 0, 0, 0);

    return { registry, custody, sensors, admin, oracle, device, carrier, handler, coldStore, truck, buyer, stranger, finishLeg1, submit };
  }

  describe("sensor registration and commits", function () {
    it("only the admin registers sensors, once each", async function () {
      const { sensors, stranger, device } = await deploy();
      await expect(sensors.connect(stranger).registerSensor(bytes32("X"), device.address)).to.be.revertedWith(
        "not admin",
      );
      await expect(sensors.registerSensor(CTR_SENSOR, stranger.address)).to.be.revertedWith(
        "sensor already registered",
      );
    });

    it("REJECTS a commit from an unregistered sensor device", async function () {
      const { sensors, stranger, finishLeg1 } = await deploy();
      await finishLeg1();
      await expect(sensors.connect(stranger).commitFileHash(1, 1, GENUINE)).to.be.revertedWith(
        "not the registered sensor for this leg",
      );
    });

    it("a sensor can only commit once its leg has ended, and only once", async function () {
      const { sensors, device, finishLeg1 } = await deploy();
      await expect(sensors.connect(device).commitFileHash(1, 1, GENUINE)).to.be.revertedWith("leg not finished");

      await finishLeg1();
      await expect(sensors.connect(device).commitFileHash(1, 1, GENUINE))
        .to.emit(sensors, "FileHashCommitted")
        .withArgs(1, 1, CTR_SENSOR, GENUINE);
      await expect(sensors.connect(device).commitFileHash(1, 1, TAMPERED)).to.be.revertedWith(
        "leg already committed",
      );
    });

    it("a container leg committed via a batch id is stored on the container", async function () {
      const { sensors, device, finishLeg1 } = await deploy();
      await finishLeg1();
      await sensors.connect(device).commitFileHash(2, 1, GENUINE); // batch id, leg 1
      expect(await sensors.committedHash(1, 1)).to.equal(GENUINE);
      await expect(sensors.connect(device).commitFileHash(1, 1, GENUINE)).to.be.revertedWith(
        "leg already committed",
      );
    });
  });

  describe("leg summaries", function () {
    it("REJECTS a summary from an unregistered oracle", async function () {
      const { sensors, device, stranger, finishLeg1, submit } = await deploy();
      await finishLeg1();
      await sensors.connect(device).commitFileHash(1, 1, GENUINE);
      await expect(submit(stranger, 2, 1, GENUINE)).to.be.revertedWith("not a registered oracle");
    });

    it("needs the sensor's commit first", async function () {
      const { oracle, finishLeg1, submit } = await deploy();
      await finishLeg1();
      await expect(submit(oracle, 2, 1, GENUINE)).to.be.revertedWith("sensor has not committed this leg");
    });

    it("summaries are per batch, not per container", async function () {
      const { sensors, device, oracle, finishLeg1, submit } = await deploy();
      await finishLeg1();
      await sensors.connect(device).commitFileHash(1, 1, GENUINE);
      await expect(submit(oracle, 1, 1, GENUINE)).to.be.revertedWith("not a batch");
    });

    it("a matching hash is Verified and the summary is stored", async function () {
      const { sensors, device, oracle, finishLeg1 } = await deploy();
      await finishLeg1();
      await sensors.connect(device).commitFileHash(1, 1, GENUINE);

      await expect(sensors.connect(oracle).submitLegSummary(2, 1, GENUINE, 18, 72, 42, 1000, 3520))
        .to.emit(sensors, "LegSummarySubmitted")
        .withArgs(2, 1, GENUINE, Status.Verified);

      const s = await sensors.getSummary(2, 1);
      expect(s.status).to.equal(Status.Verified);
      expect(s.maxTenthsC).to.equal(72n);
      expect(s.breachMinutes).to.equal(42n);
      expect(s.breachStart).to.equal(1000n);
    });

    it("REJECTS submitting the same leg twice", async function () {
      const { sensors, device, oracle, finishLeg1, submit } = await deploy();
      await finishLeg1();
      await sensors.connect(device).commitFileHash(1, 1, GENUINE);
      await submit(oracle, 2, 1, GENUINE);
      await expect(submit(oracle, 2, 1, GENUINE)).to.be.revertedWith("leg already submitted");
    });

    it("a tampered file is marked EvidenceMismatch, and can be replaced by the genuine one", async function () {
      const { sensors, device, oracle, finishLeg1, submit } = await deploy();
      await finishLeg1();
      await sensors.connect(device).commitFileHash(1, 1, GENUINE);

      await expect(submit(oracle, 2, 1, TAMPERED))
        .to.emit(sensors, "EvidenceMismatch")
        .withArgs(2, 1, GENUINE, TAMPERED);
      expect((await sensors.getSummary(2, 1)).status).to.equal(Status.EvidenceMismatch);

      // Resubmitting the genuine file clears the mismatch.
      await submit(oracle, 2, 1, GENUINE);
      expect((await sensors.getSummary(2, 1)).status).to.equal(Status.Verified);
    });

    it("rejects inconsistent summaries", async function () {
      const { sensors, device, oracle, finishLeg1 } = await deploy();
      await finishLeg1();
      await sensors.connect(device).commitFileHash(1, 1, GENUINE);
      await expect(sensors.connect(oracle).submitLegSummary(2, 1, GENUINE, 50, 20, 0, 0, 0)).to.be.revertedWith(
        "min above max",
      );
      await expect(sensors.connect(oracle).submitLegSummary(2, 1, GENUINE, 20, 50, 5, 900, 100)).to.be.revertedWith(
        "breach ends before it starts",
      );
    });
  });

  it("verifyFileHash checks any CSV hash against the sensor's commit", async function () {
    const { sensors, device, finishLeg1 } = await deploy();
    await finishLeg1();
    expect(await sensors.verifyFileHash(2, 1, GENUINE)).to.equal(false, "nothing committed yet");
    await sensors.connect(device).commitFileHash(1, 1, GENUINE);
    expect(await sensors.verifyFileHash(2, 1, GENUINE)).to.equal(true);
    expect(await sensors.verifyFileHash(2, 1, TAMPERED)).to.equal(false);
  });

  it("leg 4 is committed per batch with the batch's own sensor", async function () {
    const { custody, sensors, device, oracle, handler, coldStore, truck, buyer, finishLeg1, submit } = await deploy();
    await finishLeg1();
    await custody.connect(handler).initiateTransfer(1, coldStore.address, OK);
    await custody.connect(coldStore).acceptTransfer(1, OK);
    await custody.connect(coldStore).splitContainer(1);
    await custody.connect(coldStore).initiateTransfer(2, truck.address, OK);
    await custody.connect(truck).acceptTransfer(2, OK);
    await custody.connect(truck).initiateTransfer(2, buyer.address, OK);
    await custody.connect(buyer).acceptTransfer(2, OK);

    await expect(sensors.connect(device).commitFileHash(2, 4, GENUINE))
      .to.emit(sensors, "FileHashCommitted")
      .withArgs(2, 4, BATCH_SENSOR, GENUINE);
    await submit(oracle, 2, 4, GENUINE);
    expect((await sensors.getSummary(2, 4)).status).to.equal(Status.Verified);
  });

  it("everything stops while paused", async function () {
    const { registry, sensors, device, finishLeg1 } = await deploy();
    await finishLeg1();
    await registry.pause();
    await expect(sensors.connect(device).commitFileHash(1, 1, GENUINE)).to.be.revertedWith("system paused");
  });
});
