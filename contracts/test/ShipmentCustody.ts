import { expect } from "chai";
import { network } from "hardhat";
import { AUTO, OK, Stage, deploy } from "./fixtures.ts";

const { ethers, networkHelpers } = await network.create();
const number = (code: string) => ethers.hexlify(ethers.toUtf8Bytes(code));
const codeOf = (u: { code: string }) => ethers.toUtf8String(u.code);

describe("ShipmentCustody", function () {
  const setup = () => deploy(ethers);

  /** Batches A and B (two buyers) received into one container by Cargo. */
  async function inContainer() {
    const f = await setup();
    const salmon = await f.newBatch();
    const cheese = await f.newBatch({ buyer: f.otherBuyer, threshold: 80 });
    const container = await f.newContainer();
    await f.toCargo(salmon, container);
    await f.toCargo(cheese, container);
    return { ...f, salmon, cheese, container };
  }

  /** The container delivered to the cold store and unloaded. */
  async function unloaded() {
    const f = await inContainer();
    await f.toHandler(f.container);
    await f.toColdStore(f.container);
    return f;
  }

  /** The container handed to the cold store, not yet unloaded and with no cold-room sensor yet. */
  async function atColdStore() {
    const f = await inContainer();
    await f.toHandler(f.container);
    await f.custody.connect(f.handler).initiateTransfer(f.container, f.coldStore.address, OK);
    await f.custody.connect(f.coldStore).acceptTransfer(f.container, OK);
    return f;
  }

  describe("the supplier's batches", function () {
    it("only suppliers create batches, each with its own buyer, inspector, limit and grace period", async function () {
      const { custody, supplier, buyer, inspector, stranger, carrier } = await setup();
      await expect(custody.connect(carrier).createBatch(buyer.address, inspector.address, 40, 15)).to.be.revertedWith("not a supplier");
      await expect(custody.connect(supplier).createBatch(stranger.address, inspector.address, 40, 15)).to.be.revertedWith(
        "buyer not registered",
      );
      await expect(custody.connect(supplier).createBatch(buyer.address, stranger.address, 40, 15)).to.be.revertedWith(
        "inspector not registered",
      );

      await expect(custody.connect(supplier).createBatch(buyer.address, inspector.address, 25, 30))
        .to.emit(custody, "BatchCreated")
        .withArgs(1, supplier.address, buyer.address, inspector.address, 25, 30);
      const batch = await custody.getUnit(1);
      expect(batch.supplier).to.equal(supplier.address);
      expect(batch.custodian).to.equal(supplier.address);
      expect(batch.stage).to.equal(Stage.Origin);
      expect(batch.thresholdTenthsC).to.equal(25n);
      expect(batch.graceMinutes).to.equal(30n);
      expect(batch.containerId).to.equal(0n, "not in a container yet");
    });

    it("the supplier must register its cold-room sensor before signing a batch off", async function () {
      const { custody, supplier, carrier, buyer, inspector } = await setup();
      await custody.connect(supplier).createBatch(buyer.address, inspector.address, 40, 15);
      await expect(custody.connect(supplier).initiateTransfer(1, carrier.address, OK)).to.be.revertedWith("register a sensor first");
    });

    it("a batch is signed off only to Cargo", async function () {
      const { custody, supplier, handler, newBatch } = await setup();
      const id = await newBatch();
      await expect(custody.connect(supplier).initiateTransfer(id, handler.address, OK)).to.be.revertedWith(
        "recipient not valid for next leg",
      );
    });
  });

  describe("Cargo's container", function () {
    it("only Cargo opens containers; each gets a valid ISO 6346 number, generated unless one is entered", async function () {
      const { custody, carrier, supplier } = await setup();
      await expect(custody.connect(supplier).createContainer(AUTO)).to.be.revertedWith("not a carrier");

      await expect(custody.connect(carrier).createContainer(AUTO)).to.emit(custody, "ContainerCreated");
      const container = await custody.getUnit(1);
      const generated = codeOf(container);
      expect(generated).to.match(/^CCSU\d{7}$/);
      expect(await custody.isValidContainerCode(number(generated))).to.equal(true);
      expect(container.custodian).to.equal(carrier.address);
      expect(container.stage).to.equal(Stage.Carrier);

      await custody.connect(carrier).createContainer(number("CSQU3054383"));
      expect(codeOf(await custody.getUnit(2))).to.equal("CSQU3054383");
      // Letters past the skipped values (V-Z are worth 34-38).
      await custody.connect(carrier).createContainer(number("ZZZU9999992"));
      await custody.connect(carrier).createContainer(AUTO);
      expect(codeOf(await custody.getUnit(4))).to.not.equal(generated, "generated numbers are unique");
    });

    it("rejects invalid or reserved container numbers, and a number already in use", async function () {
      const { custody, carrier } = await setup();
      for (const bad of ["CSQU3054384", "csqu3054383", "CSQJ3054383", "CS1U3054383", "CSQU30543A3"]) {
        await expect(custody.connect(carrier).createContainer(number(bad))).to.be.revertedWith("invalid container number", bad);
      }
      const generated = ethers.toUtf8String(await custody.containerCode(5));
      await expect(custody.connect(carrier).createContainer(number(generated))).to.be.revertedWith(
        "owner code CCS is reserved for generated numbers",
      );
      await custody.connect(carrier).createContainer(number("MSKU9070323"));
      await expect(custody.connect(carrier).createContainer(number("MSKU9070323"))).to.be.revertedWith("container number already in use");
    });

    it("Cargo receives each batch straight into an open container of its own", async function () {
      const { custody, supplier, carrier, newBatch, newContainer } = await setup();
      const batch = await newBatch();
      const container = await newContainer();
      await custody.connect(supplier).initiateTransfer(batch, carrier.address, OK);

      await expect(custody.connect(carrier).acceptTransfer(batch, OK)).to.be.revertedWith("receive the batch into a container");
      await expect(custody.connect(carrier).acceptIntoContainer(batch, batch, OK)).to.be.revertedWith("not an open container of yours");

      await expect(custody.connect(carrier).acceptIntoContainer(batch, container, OK))
        .to.emit(custody, "BatchLoaded")
        .withArgs(batch, container);
      const b = await custody.getUnit(batch);
      expect(b.custodian).to.equal(carrier.address);
      expect(b.stage).to.equal(Stage.Carrier);
      expect(b.containerId).to.equal(BigInt(container));
      expect(b.code).to.equal((await custody.getUnit(container)).code, "a batch carries its container's number");
      expect(await custody.getBatches(container)).to.deep.equal([BigInt(batch)]);
    });

    it("Cargo seals the container after loading; the seal is required to dispatch and fixed after", async function () {
      const { custody, carrier, handler, stranger, newBatch, newContainer, toCargo, SEAL } = await setup();
      const container = await newContainer();
      await expect(custody.connect(carrier).recordSeal(container, SEAL)).to.be.revertedWith("load a batch first");
      await toCargo(await newBatch(), container);
      await expect(custody.connect(carrier).initiateTransfer(container, handler.address, OK)).to.be.revertedWith(
        "record the seal number first",
      );
      await expect(custody.connect(stranger).recordSeal(container, SEAL)).to.be.revertedWith("not the current custodian");
      await expect(custody.connect(carrier).recordSeal(container, ethers.ZeroHash)).to.be.revertedWith("seal number required");

      await expect(custody.connect(carrier).recordSeal(container, SEAL)).to.emit(custody, "SealRecorded").withArgs(container, SEAL);
      await custody.connect(carrier).initiateTransfer(container, handler.address, OK);
      await expect(custody.connect(carrier).recordSeal(container, SEAL)).to.be.revertedWith("container already dispatched");
      expect((await custody.getUnit(container)).sealNumber).to.equal(SEAL);
    });

    it("no more batches go in once the container is sealed", async function () {
      const { custody, supplier, carrier, newBatch, newContainer, toCargo, SEAL } = await setup();
      const container = await newContainer();
      await toCargo(await newBatch(), container);
      await custody.connect(carrier).recordSeal(container, SEAL);
      const late = await newBatch();
      await custody.connect(supplier).initiateTransfer(late, carrier.address, OK);
      await expect(custody.connect(carrier).acceptIntoContainer(late, container, OK)).to.be.revertedWith("container already sealed");
    });

    it("the container's sensor must be registered before it's dispatched", async function () {
      const { custody, supplier, carrier, handler, newBatch, SEAL } = await setup();
      const batch = await newBatch();
      const container = Number(await custody.nextId());
      await custody.connect(carrier).createContainer(AUTO);
      await custody.connect(supplier).initiateTransfer(batch, carrier.address, OK);
      await custody.connect(carrier).acceptIntoContainer(batch, container, OK);
      await custody.connect(carrier).recordSeal(container, SEAL);
      await expect(custody.connect(carrier).initiateTransfer(container, handler.address, OK)).to.be.revertedWith("register a sensor first");
    });
  });

  describe("the container travels; its batches go with it", function () {
    it("each container handover moves custody of every batch inside it", async function () {
      const { custody, handler, coldStore, salmon, cheese, container, toHandler } = await inContainer();
      await toHandler(container);
      for (const id of [container, salmon, cheese]) {
        const u = await custody.getUnit(id);
        expect(u.custodian).to.equal(handler.address);
        expect(u.stage).to.equal(Stage.Handler);
      }
      await custody.connect(handler).initiateTransfer(container, coldStore.address, OK);
      await custody.connect(coldStore).acceptTransfer(container, OK);
      expect((await custody.getUnit(salmon)).custodian).to.equal(coldStore.address);
      expect((await custody.getUnit(salmon)).stage).to.equal(Stage.ColdStore);
    });

    it("a batch can't move on its own while it's inside a container", async function () {
      const { custody, carrier, handler, salmon } = await inContainer();
      await expect(custody.connect(carrier).initiateTransfer(salmon, handler.address, OK)).to.be.revertedWith("batch is inside a container");
    });

    it("REJECTS a transfer from anyone but the current custodian, and an accept by anyone but the named recipient", async function () {
      const { custody, carrier, handler, stranger, container, SEAL } = await inContainer();
      await custody.connect(carrier).recordSeal(container, SEAL);
      await expect(custody.connect(stranger).initiateTransfer(container, handler.address, OK)).to.be.revertedWith(
        "not the current custodian",
      );
      await custody.connect(carrier).initiateTransfer(container, handler.address, OK);
      await expect(custody.connect(stranger).acceptTransfer(container, OK)).to.be.revertedWith("no transfer pending for you");
    });

    it("rejects recipients with the wrong role, and a recipient suspended after initiation", async function () {
      const { registry, custody, carrier, handler, coldStore, container, SEAL } = await inContainer();
      await custody.connect(carrier).recordSeal(container, SEAL);
      await expect(custody.connect(carrier).initiateTransfer(container, coldStore.address, OK)).to.be.revertedWith(
        "recipient not valid for next leg",
      );
      await custody.connect(carrier).initiateTransfer(container, handler.address, OK);
      await registry.suspendParticipant(handler.address);
      await expect(custody.connect(handler).acceptTransfer(container, OK)).to.be.revertedWith("recipient not valid for next leg");
    });
  });

  describe("the cold store unloads; batches go on by reefer truck", function () {
    it("only the cold store unloads, once, and only after receiving the container", async function () {
      const f = await inContainer();
      await expect(f.custody.connect(f.carrier).unloadContainer(f.container)).to.be.revertedWith("container not at cold store");
      const { custody, coldStore, stranger, container } = await atColdStore();
      await expect(custody.connect(stranger).unloadContainer(container)).to.be.revertedWith("not the current custodian");
      await expect(custody.connect(coldStore).unloadContainer(container)).to.emit(custody, "ContainerUnloaded");
      await expect(custody.connect(coldStore).unloadContainer(container)).to.be.revertedWith("already unloaded");
    });

    it("batches leave the cold store only after unloading, each with the cold store's sensor; the container never leaves", async function () {
      const { custody, coldStore, truck, container, salmon, SENSOR, device } = await atColdStore();
      await custody.connect(coldStore).registerSensor([salmon], SENSOR.coldStore, device.address);
      await expect(custody.connect(coldStore).initiateTransfer(salmon, truck.address, OK)).to.be.revertedWith("batch is inside a container");
      await custody.connect(coldStore).unloadContainer(container);
      await expect(custody.connect(coldStore).initiateTransfer(container, truck.address, OK)).to.be.revertedWith(
        "container already unloaded",
      );
      await custody.connect(coldStore).initiateTransfer(salmon, truck.address, OK);
    });

    it("the cold store and the truck each register their own sensor before signing off", async function () {
      const { custody, coldStore, truck, buyer, salmon, container, SENSOR, device } = await atColdStore();
      await custody.connect(coldStore).unloadContainer(container);
      await expect(custody.connect(coldStore).initiateTransfer(salmon, truck.address, OK)).to.be.revertedWith("register a sensor first");
      await custody.connect(coldStore).registerSensor([salmon], SENSOR.coldStore, device.address);
      await custody.connect(coldStore).initiateTransfer(salmon, truck.address, OK);
      await custody.connect(truck).acceptTransfer(salmon, OK);
      await expect(custody.connect(truck).initiateTransfer(salmon, buyer.address, OK)).to.be.revertedWith("register a sensor first");
    });

    it("each batch reaches only its own buyer, and delivery is final", async function () {
      const { custody, truck, buyer, otherBuyer, salmon, cheese, coldStore, toTruck, toBuyer } = await unloaded();
      await toTruck(salmon);
      await expect(custody.connect(truck).initiateTransfer(salmon, otherBuyer.address, OK)).to.be.revertedWith(
        "recipient not valid for next leg",
      );
      await toBuyer(salmon);
      expect((await custody.getUnit(salmon)).stage).to.equal(Stage.Delivered);
      await expect(custody.connect(buyer).initiateTransfer(salmon, truck.address, OK)).to.be.revertedWith("batch already delivered");
      expect((await custody.getUnit(cheese)).custodian).to.equal(coldStore.address, "the other batch is untouched");
    });

    it("a container number is free again once the container is unloaded", async function () {
      const f = await setup();
      const BOX = number("MSKU9070323");
      const container = await f.newContainer(BOX);
      await f.toCargo(await f.newBatch(), container);
      await f.toHandler(container);
      await f.toColdStore(container);
      await expect(f.custody.connect(f.carrier).createContainer(BOX)).to.emit(f.custody, "ContainerCreated");
    });
  });

  describe("sensors", function () {
    it("each party registers its own sensor for the stage it holds; the container's covers stages 1 and 2", async function () {
      const { custody, carrier, device, SENSOR, salmon, container } = await inContainer();
      const s0 = await custody.getSensor(salmon, 0);
      expect(s0.sensorId).to.equal(SENSOR.supplier);
      expect(s0.device).to.equal(device.address);
      for (const stage of [1, 2]) {
        const s = await custody.getSensor(container, stage);
        expect(s.sensorId).to.equal(SENSOR.container);
        expect(s.owner).to.equal(carrier.address);
      }
      // Asked about a batch, stages 1-2 resolve to its container's sensor.
      expect((await custody.getSensor(salmon, 1)).sensorId).to.equal(SENSOR.container);
    });

    it("only the current custodian registers, once per stage, and not for a batch inside a container", async function () {
      const { custody, carrier, handler, stranger, device, salmon, container, toHandler } = await inContainer();
      await expect(custody.connect(stranger).registerSensor([container], ethers.id("X"), device.address)).to.be.revertedWith(
        "not the current custodian",
      );
      await expect(custody.connect(carrier).registerSensor([container], ethers.id("X"), device.address)).to.be.revertedWith(
        "sensor already registered for this stage",
      );
      await expect(custody.connect(carrier).registerSensor([salmon], ethers.id("X"), device.address)).to.be.revertedWith(
        "the container's sensor covers this batch",
      );
      await toHandler(container);
      await expect(custody.connect(handler).registerSensor([container], ethers.id("X"), device.address)).to.be.revertedWith(
        "the container's sensor covers this stage",
      );
    });

    it("a sensor belongs to the participant who first registered it, on one device; one room can cover many batches", async function () {
      const { custody, carrier, supplier, stranger, device, SENSOR, newBatch, buyer, inspector } = await setup();
      await newBatch();
      const container = Number(await custody.nextId());
      await custody.connect(carrier).createContainer(AUTO);
      await expect(custody.connect(carrier).registerSensor([container], SENSOR.supplier, device.address)).to.be.revertedWith(
        "sensor belongs to another participant",
      );
      const second = Number(await custody.nextId());
      await custody.connect(supplier).createBatch(buyer.address, inspector.address, 40, 15);
      await expect(custody.connect(supplier).registerSensor([second], SENSOR.supplier, stranger.address)).to.be.revertedWith(
        "sensor is bound to another device",
      );
      await expect(custody.connect(supplier).registerSensor([second], SENSOR.supplier, device.address))
        .to.emit(custody, "SensorRegistered")
        .withArgs(second, 0, SENSOR.supplier, device.address, supplier.address);
    });
  });

  describe("entry, exit and the handover gaps between them", function () {
    it("each stage runs from the receiver's sign-in (entry) to the sender's sign-off (exit)", async function () {
      const f = await unloaded();
      const { custody, salmon, container } = f;
      await f.toTruck(salmon);
      await f.toBuyer(salmon);

      const created = (await custody.getUnit(salmon)).createdAt;
      const s0 = await custody.getCheckpoint(salmon, 0);
      const c1 = await custody.getCheckpoint(container, 1);
      const c2 = await custody.getCheckpoint(container, 2);
      const s3 = await custody.getCheckpoint(salmon, 3);
      const s4 = await custody.getCheckpoint(salmon, 4);

      const w0 = await custody.stageWindow(salmon, 0);
      expect([w0.start, w0.end, w0.custodian]).to.deep.equal([created, s0.outgoing.checkedAt, f.supplier.address]);
      // The container's sensor keeps reading through the Cargo → handler handover: no gap there.
      const w1 = await custody.stageWindow(salmon, 1);
      expect([w1.start, w1.end, w1.unit, w1.custodian]).to.deep.equal([
        s0.incoming.checkedAt,
        c1.incoming.checkedAt,
        BigInt(container),
        f.carrier.address,
      ]);
      const w2 = await custody.stageWindow(salmon, 2);
      expect([w2.start, w2.end, w2.custodian]).to.deep.equal([c1.incoming.checkedAt, c2.outgoing.checkedAt, f.handler.address]);
      const w3 = await custody.stageWindow(salmon, 3);
      expect([w3.start, w3.end, w3.unit, w3.custodian]).to.deep.equal([
        c2.incoming.checkedAt,
        s3.outgoing.checkedAt,
        BigInt(salmon),
        f.coldStore.address,
      ]);
      const w4 = await custody.stageWindow(salmon, 4);
      expect([w4.start, w4.end, w4.custodian]).to.deep.equal([s3.incoming.checkedAt, s4.outgoing.checkedAt, f.truck.address]);
    });

    it("the gap is the real time from the sender's sign-off to the receiver's sign-in, in whole minutes", async function () {
      const { custody, supplier, carrier, newBatch, newContainer } = await setup();
      const batch = await newBatch();
      const container = await newContainer();
      await custody.connect(supplier).initiateTransfer(batch, carrier.address, OK);
      await networkHelpers.time.increase(20 * 60 + 29); // + 1 s for the sign-in's own block: 20 min 30 s
      await custody.connect(carrier).acceptIntoContainer(batch, container, OK);
      expect(await custody.handoverGapMinutes(batch, 0)).to.equal(20n);
      expect(await custody.handoverGapMinutes(batch, 1)).to.equal(0n, "not handed over yet");
    });

    it("a stage still in progress has no end; a container's sensor window starts when it's opened", async function () {
      const { custody, salmon, container } = await inContainer();
      expect((await custody.stageWindow(salmon, 1)).end).to.equal(0n);
      const w = await custody.sensorWindow(container, 1);
      expect(w.start).to.equal((await custody.getUnit(container)).createdAt);
      expect(w.end).to.equal(0n);
      await expect(custody.sensorWindow(salmon, 1)).to.be.revertedWith("stage is recorded on the container");
    });
  });

  describe("handover quality checks", function () {
    it("stores both sides against the stage the handover closes: stage 0 on the batch, 1-2 on the container", async function () {
      const { custody, supplier, carrier, newBatch, newContainer } = await setup();
      const batch = await newBatch();
      const container = await newContainer();
      const dispatch = { ...OK, tempTenthsC: 28, notesHash: ethers.id("supplier notes") };
      const receipt = { ...OK, tempTenthsC: 61, issues: true, damaged: true };

      await custody.connect(supplier).initiateTransfer(batch, carrier.address, dispatch);
      expect((await custody.getPendingCheck(batch)).by).to.equal(supplier.address);
      await expect(custody.connect(carrier).acceptIntoContainer(batch, container, receipt))
        .to.emit(custody, "CheckpointRecorded")
        .withArgs(batch, 0, 28, 61, true);

      const cp = await custody.getCheckpoint(batch, 0);
      expect(cp.outgoing.by).to.equal(supplier.address);
      expect(cp.outgoing.notesHash).to.equal(ethers.id("supplier notes"));
      expect(cp.incoming.by).to.equal(carrier.address);
      expect(cp.incoming.damaged).to.equal(true);
      expect((await custody.getPendingCheck(batch)).checkedAt).to.equal(0n, "cleared once accepted");
      expect(await custody.recordedOn(batch, 0)).to.equal(BigInt(batch));
      expect(await custody.recordedOn(batch, 1)).to.equal(BigInt(container));
      expect(await custody.recordedOn(batch, 3)).to.equal(BigInt(batch));
    });

    it("re-initiating replaces the pending outgoing check", async function () {
      const { custody, supplier, carrier, newBatch } = await setup();
      const batch = await newBatch();
      await custody.connect(supplier).initiateTransfer(batch, carrier.address, { ...OK, tempTenthsC: 50 });
      await custody.connect(supplier).initiateTransfer(batch, carrier.address, { ...OK, tempTenthsC: 31 });
      expect((await custody.getPendingCheck(batch)).tempTenthsC).to.equal(31n);
    });

    it("rejects implausible probe readings", async function () {
      const { custody, supplier, carrier, newBatch } = await setup();
      const batch = await newBatch();
      await expect(custody.connect(supplier).initiateTransfer(batch, carrier.address, { ...OK, tempTenthsC: 900 })).to.be.revertedWith(
        "temperature out of range",
      );
    });
  });

  it("everything stops while the system is paused", async function () {
    const { registry, custody, supplier, carrier, buyer, inspector, newBatch } = await setup();
    const batch = await newBatch();
    await registry.pause();
    await expect(custody.connect(supplier).initiateTransfer(batch, carrier.address, OK)).to.be.revertedWith("system paused");
    await expect(custody.connect(supplier).createBatch(buyer.address, inspector.address, 40, 15)).to.be.revertedWith("system paused");
    await expect(custody.connect(carrier).createContainer(AUTO)).to.be.revertedWith("system paused");
    await registry.unpause();
    await custody.connect(supplier).initiateTransfer(batch, carrier.address, OK);
  });
});
