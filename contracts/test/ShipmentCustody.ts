import { expect } from "chai";
import { network } from "hardhat";

/** A passing quality check: 3.0 °C, nothing unrefrigerated, sealed, no issues. */
const OK = { tempTenthsC: 30, unrefrigeratedMinutes: 0, damaged: false, sealIntact: true, issues: false, notesHash: "0x" + "0".repeat(64) };

const { ethers, networkHelpers } = await network.create();

const role = (name: string) => ethers.id(name);
const SENSOR = ethers.encodeBytes32String("SENSOR-CTR-01");
const BATCH_SENSOR = ethers.encodeBytes32String("SENSOR-B-01");
const Stage = { Origin: 0n, Carrier: 1n, Handler: 2n, ColdStore: 3n, Truck: 4n, Delivered: 5n };

describe("ShipmentCustody", function () {
  async function deploy() {
    const [admin, importer, carrier, handler, coldStore, truck, buyer, inspector, otherBuyer, stranger] =
      await ethers.getSigners();
    const registry = await ethers.deployContract("ParticipantRegistry", [admin.address]);
    const custody = await ethers.deployContract("ShipmentCustody", [await registry.getAddress()]);

    const roles: [typeof admin, string][] = [
      [importer, "IMPORTER"],
      [carrier, "CARRIER"],
      [handler, "HANDLER"],
      [coldStore, "COLD_STORE"],
      [truck, "TRUCK"],
      [buyer, "BUYER"],
      [inspector, "INSPECTOR"],
      [otherBuyer, "BUYER"],
    ];
    for (const [signer, name] of roles) await registry.registerParticipant(signer.address, role(name));

    return { registry, custody, admin, importer, carrier, handler, coldStore, truck, buyer, inspector, otherBuyer, stranger };
  }

  /** Container 1 with batches 2 and 3, still at origin. */
  async function withContainer() {
    const f = await deploy();
    const { custody, importer, buyer, inspector, otherBuyer } = f;
    await custody.connect(importer).createContainer(SENSOR);
    await custody.connect(importer).addBatch(1, buyer.address, inspector.address, 40, 15, BATCH_SENSOR);
    await custody.connect(importer).addBatch(1, otherBuyer.address, inspector.address, 40, 15, BATCH_SENSOR);
    return f;
  }

  /** Moves the container to the cold store (legs 1-3), one hour per leg. */
  async function atColdStore() {
    const f = await withContainer();
    const { custody, importer, carrier, handler, coldStore } = f;
    for (const [from, to] of [
      [importer, carrier],
      [carrier, handler],
      [handler, coldStore],
    ]) {
      await custody.connect(from).initiateTransfer(1, to.address, OK);
      await custody.connect(to).acceptTransfer(1, OK);
      await networkHelpers.time.increase(3600);
    }
    return f;
  }

  describe("setup", function () {
    it("only importers can create containers", async function () {
      const { custody, importer, stranger } = await deploy();
      await expect(custody.connect(stranger).createContainer(SENSOR)).to.be.revertedWith("not an importer");
      await expect(custody.connect(importer).createContainer(SENSOR))
        .to.emit(custody, "ContainerCreated")
        .withArgs(1, importer.address, SENSOR);
    });

    it("batches need a registered buyer and inspector, and only the container's importer can add them", async function () {
      const { custody, importer, buyer, inspector, stranger } = await deploy();
      await custody.connect(importer).createContainer(SENSOR);

      await expect(
        custody.connect(importer).addBatch(1, stranger.address, inspector.address, 40, 15, BATCH_SENSOR),
      ).to.be.revertedWith("buyer not registered");
      await expect(
        custody.connect(importer).addBatch(1, buyer.address, stranger.address, 40, 15, BATCH_SENSOR),
      ).to.be.revertedWith("inspector not registered");
      await expect(
        custody.connect(stranger).addBatch(1, buyer.address, inspector.address, 40, 15, BATCH_SENSOR),
      ).to.be.revertedWith("not this container's importer");

      await custody.connect(importer).addBatch(1, buyer.address, inspector.address, 25, 30, BATCH_SENSOR);
      const batch = await custody.getUnit(2);
      expect(batch.thresholdTenthsC).to.equal(25n);
      expect(batch.graceMinutes).to.equal(30n);
      expect(await custody.getBatches(1)).to.deep.equal([2n]);
    });

    it("cannot dispatch an empty container, or add batches after dispatch", async function () {
      const { custody, importer, carrier, buyer, inspector } = await deploy();
      await custody.connect(importer).createContainer(SENSOR);
      await expect(custody.connect(importer).initiateTransfer(1, carrier.address, OK)).to.be.revertedWith(
        "add a batch first",
      );

      await custody.connect(importer).addBatch(1, buyer.address, inspector.address, 40, 15, BATCH_SENSOR);
      await custody.connect(importer).initiateTransfer(1, carrier.address, OK);
      await custody.connect(carrier).acceptTransfer(1, OK);
      await expect(
        custody.connect(importer).addBatch(1, buyer.address, inspector.address, 40, 15, BATCH_SENSOR),
      ).to.be.revertedWith("container already dispatched");
    });
  });

  describe("handovers", function () {
    it("moves through the route with a two-step handover", async function () {
      const { custody, importer, carrier } = await withContainer();

      await expect(custody.connect(importer).initiateTransfer(1, carrier.address, OK))
        .to.emit(custody, "TransferInitiated")
        .withArgs(1, importer.address, carrier.address);
      // Custody does not change until the recipient accepts.
      expect((await custody.getUnit(1)).custodian).to.equal(importer.address);

      await expect(custody.connect(carrier).acceptTransfer(1, OK))
        .to.emit(custody, "TransferAccepted")
        .withArgs(1, importer.address, carrier.address, Stage.Carrier);
      const unit = await custody.getUnit(1);
      expect(unit.custodian).to.equal(carrier.address);
      expect(unit.stage).to.equal(Stage.Carrier);
      expect(unit.pendingTo).to.equal(ethers.ZeroAddress);
    });

    it("REJECTS a transfer from a wallet that isn't the current custodian", async function () {
      const { custody, carrier, stranger } = await withContainer();
      await expect(custody.connect(stranger).initiateTransfer(1, carrier.address, OK)).to.be.revertedWith(
        "not the current custodian",
      );
      // The next custodian can't pull custody to themselves either.
      await expect(custody.connect(carrier).initiateTransfer(1, carrier.address, OK)).to.be.revertedWith(
        "not the current custodian",
      );
    });

    it("only the named recipient can accept", async function () {
      const { custody, importer, carrier, stranger } = await withContainer();
      await custody.connect(importer).initiateTransfer(1, carrier.address, OK);
      await expect(custody.connect(stranger).acceptTransfer(1, OK)).to.be.revertedWith("no transfer pending for you");
    });

    it("rejects recipients with the wrong role for the next leg", async function () {
      const { custody, importer, handler, coldStore } = await withContainer();
      // Origin must go to a carrier, not skip ahead.
      await expect(custody.connect(importer).initiateTransfer(1, handler.address, OK)).to.be.revertedWith(
        "recipient not valid for next leg",
      );
      await expect(custody.connect(importer).initiateTransfer(1, coldStore.address, OK)).to.be.revertedWith(
        "recipient not valid for next leg",
      );
    });

    it("a recipient suspended after initiation cannot accept", async function () {
      const { registry, custody, importer, carrier } = await withContainer();
      await custody.connect(importer).initiateTransfer(1, carrier.address, OK);
      await registry.suspendParticipant(carrier.address);
      await expect(custody.connect(carrier).acceptTransfer(1, OK)).to.be.revertedWith("recipient not valid for next leg");
    });

    it("batches cannot move on their own before the split", async function () {
      const { custody, importer, carrier } = await withContainer();
      await expect(custody.connect(importer).initiateTransfer(2, carrier.address, OK)).to.be.revertedWith(
        "not the current custodian",
      );
    });
  });

  describe("split", function () {
    it("REJECTS a split before the container reaches the importer cold store", async function () {
      const { custody, importer, carrier, handler } = await withContainer();
      await expect(custody.connect(importer).splitContainer(1)).to.be.revertedWith("container not at cold store");

      await custody.connect(importer).initiateTransfer(1, carrier.address, OK);
      await custody.connect(carrier).acceptTransfer(1, OK);
      await expect(custody.connect(carrier).splitContainer(1)).to.be.revertedWith("container not at cold store");

      await custody.connect(carrier).initiateTransfer(1, handler.address, OK);
      await custody.connect(handler).acceptTransfer(1, OK);
      await expect(custody.connect(handler).splitContainer(1)).to.be.revertedWith("container not at cold store");
    });

    it("only the cold store custodian can split, and only once", async function () {
      const { custody, coldStore, stranger } = await atColdStore();
      await expect(custody.connect(stranger).splitContainer(1)).to.be.revertedWith("not the current custodian");

      await expect(custody.connect(coldStore).splitContainer(1))
        .to.emit(custody, "ContainerSplit")
        .withArgs(1, [2n, 3n]);
      await expect(custody.connect(coldStore).splitContainer(1)).to.be.revertedWith("already split");
    });

    it("the container must be split before anything leaves the cold store", async function () {
      const { custody, coldStore, truck } = await atColdStore();
      await expect(custody.connect(coldStore).initiateTransfer(1, truck.address, OK)).to.be.revertedWith(
        "split the container first",
      );
    });

    it("after the split each batch travels separately and only reaches its own buyer", async function () {
      const { custody, coldStore, truck, buyer, otherBuyer } = await atColdStore();
      await custody.connect(coldStore).splitContainer(1);

      const batch = await custody.getUnit(2);
      expect(batch.custodian).to.equal(coldStore.address);
      expect(batch.stage).to.equal(Stage.ColdStore);

      await expect(custody.connect(coldStore).initiateTransfer(1, truck.address, OK)).to.be.revertedWith(
        "container already split",
      );

      await custody.connect(coldStore).initiateTransfer(2, truck.address, OK);
      await custody.connect(truck).acceptTransfer(2, OK);

      await expect(custody.connect(truck).initiateTransfer(2, otherBuyer.address, OK)).to.be.revertedWith(
        "recipient not valid for next leg",
      );
      await custody.connect(truck).initiateTransfer(2, buyer.address, OK);
      await custody.connect(buyer).acceptTransfer(2, OK);
      expect((await custody.getUnit(2)).stage).to.equal(Stage.Delivered);

      // Delivered is final.
      await expect(custody.connect(buyer).initiateTransfer(2, truck.address, OK)).to.be.revertedWith(
        "recipient not valid for next leg",
      );
      // Batch 3 is untouched.
      expect((await custody.getUnit(3)).custodian).to.equal(coldStore.address);
    });
  });

  describe("evidence views", function () {
    it("getCustodianAt walks container history, then batch history", async function () {
      const { custody, importer, carrier, handler, coldStore, truck } = await atColdStore();
      const containerHistory = await custody.getHistory(1);
      await custody.connect(coldStore).splitContainer(1);
      await networkHelpers.time.increase(600);
      await custody.connect(coldStore).initiateTransfer(2, truck.address, OK);
      await custody.connect(truck).acceptTransfer(2, OK);
      await networkHelpers.time.increase(3600);

      const [origin, legCarrier, legHandler] = containerHistory.map((h) => h.startedAt);
      expect((await custody.getCustodianAt(2, origin))[0]).to.equal(importer.address);
      expect(await custody.getCustodianAt(2, legCarrier + 1800n)).to.deep.equal([carrier.address, Stage.Carrier]);
      expect(await custody.getCustodianAt(2, legHandler + 10n)).to.deep.equal([handler.address, Stage.Handler]);

      const now = BigInt(await networkHelpers.time.latest());
      expect(await custody.getCustodianAt(2, now)).to.deep.equal([truck.address, Stage.Truck]);
      expect((await custody.getCustodianAt(2, origin - 1n))[0]).to.equal(ethers.ZeroAddress);
      // Batch 3 never left the cold store.
      expect((await custody.getCustodianAt(3, now))[0]).to.equal(coldStore.address);
    });

    it("legWindow returns custodian, time window and sensor for each leg", async function () {
      const { custody, carrier, coldStore, truck, buyer } = await atColdStore();
      await custody.connect(coldStore).splitContainer(1);
      await custody.connect(coldStore).initiateTransfer(2, truck.address, OK);
      await custody.connect(truck).acceptTransfer(2, OK);

      const h = await custody.getHistory(1);
      const leg1 = await custody.legWindow(2, 1);
      expect(leg1.custodian).to.equal(carrier.address);
      expect(leg1.start).to.equal(h[1].startedAt);
      expect(leg1.end).to.equal(h[2].startedAt);
      expect(leg1.sensorId).to.equal(SENSOR);
      expect(leg1.recordedOn).to.equal(1n, "legs 1-3 are recorded on the container");

      const leg3 = await custody.legWindow(1, 3);
      expect(leg3.custodian).to.equal(coldStore.address);
      expect(leg3.end).to.equal((await custody.getUnit(1)).splitAt);

      const leg4 = await custody.legWindow(2, 4);
      expect(leg4.custodian).to.equal(truck.address);
      expect(leg4.end).to.equal(0n, "still in progress");
      expect(leg4.sensorId).to.equal(BATCH_SENSOR);

      await custody.connect(truck).initiateTransfer(2, buyer.address, OK);
      await custody.connect(buyer).acceptTransfer(2, OK);
      expect((await custody.legWindow(2, 4)).end).to.be.greaterThan(0n);

      await expect(custody.legWindow(1, 4)).to.be.revertedWith("leg 4 is per batch");
    });
  });

  describe("handover quality checkpoints", function () {
    it("stores both sides of the handover against the stage it closes", async function () {
      const { custody, importer, carrier } = await withContainer();
      const dispatch = { ...OK, tempTenthsC: 28, unrefrigeratedMinutes: 5, notesHash: ethers.id("importer notes") };
      const receipt = { ...OK, tempTenthsC: 61, unrefrigeratedMinutes: 12, issues: true, sealIntact: false };

      await custody.connect(importer).initiateTransfer(1, carrier.address, dispatch);
      const pending = await custody.getPendingCheck(1);
      expect(pending.tempTenthsC).to.equal(28n);
      expect(pending.by).to.equal(importer.address);

      await expect(custody.connect(carrier).acceptTransfer(1, receipt))
        .to.emit(custody, "CheckpointRecorded")
        .withArgs(1, 0, 28, 61, true);

      const cp = await custody.getCheckpoint(1, 0); // stage 0: origin dispatch
      expect(cp.outgoing.by).to.equal(importer.address);
      expect(cp.outgoing.unrefrigeratedMinutes).to.equal(5n);
      expect(cp.outgoing.notesHash).to.equal(ethers.id("importer notes"));
      expect(cp.incoming.by).to.equal(carrier.address);
      expect(cp.incoming.tempTenthsC).to.equal(61n);
      expect(cp.incoming.sealIntact).to.equal(false);
      expect(cp.incoming.issues).to.equal(true);
      expect(cp.incoming.checkedAt).to.be.greaterThan(0n);
      expect((await custody.getPendingCheck(1)).checkedAt).to.equal(0n, "cleared once accepted");
    });

    it("a receiver who finds problems still takes custody: there is no rejection", async function () {
      const { custody, importer, carrier } = await withContainer();
      await custody.connect(importer).initiateTransfer(1, carrier.address, OK);
      await custody.connect(carrier).acceptTransfer(1, { ...OK, tempTenthsC: 90, damaged: true, issues: true });
      expect((await custody.getUnit(1)).custodian).to.equal(carrier.address);
    });

    it("re-initiating replaces the pending outgoing check", async function () {
      const { custody, importer, carrier } = await withContainer();
      await custody.connect(importer).initiateTransfer(1, carrier.address, { ...OK, tempTenthsC: 50 });
      await custody.connect(importer).initiateTransfer(1, carrier.address, { ...OK, tempTenthsC: 25 });
      await custody.connect(carrier).acceptTransfer(1, OK);
      expect((await custody.getCheckpoint(1, 0)).outgoing.tempTenthsC).to.equal(25n);
    });

    it("rejects implausible readings", async function () {
      const { custody, importer, carrier } = await withContainer();
      await expect(custody.connect(importer).initiateTransfer(1, carrier.address, { ...OK, tempTenthsC: 700 })).to.be.revertedWith(
        "temperature out of range",
      );
      await expect(
        custody.connect(importer).initiateTransfer(1, carrier.address, { ...OK, unrefrigeratedMinutes: 20000 }),
      ).to.be.revertedWith("unrefrigerated minutes out of range");
    });

    it("the cold store's checkpoint is per batch, at truck pickup", async function () {
      const { custody, coldStore, truck } = await atColdStore();
      await custody.connect(coldStore).splitContainer(1);
      await custody.connect(coldStore).initiateTransfer(2, truck.address, { ...OK, tempTenthsC: 33 });
      await custody.connect(truck).acceptTransfer(2, { ...OK, tempTenthsC: 35 });
      const cp = await custody.getCheckpoint(2, 3);
      expect(cp.outgoing.by).to.equal(coldStore.address);
      expect(cp.incoming.tempTenthsC).to.equal(35n);
      expect((await custody.getCheckpoint(3, 3)).incoming.checkedAt).to.equal(0n, "batch 3 not picked up yet");
    });
  });

  it("everything stops while the system is paused", async function () {
    const { registry, custody, importer, carrier } = await withContainer();
    await registry.pause();
    await expect(custody.connect(importer).initiateTransfer(1, carrier.address, OK)).to.be.revertedWith("system paused");
    await expect(custody.connect(importer).createContainer(SENSOR)).to.be.revertedWith("system paused");
    await registry.unpause();
    await custody.connect(importer).initiateTransfer(1, carrier.address, OK);
  });
});
