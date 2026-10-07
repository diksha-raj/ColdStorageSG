import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const role = (name: string) => ethers.id(name);
const bytes32 = (s: string) => ethers.encodeBytes32String(s);
const fileHash = (leg: number) => ethers.sha256(ethers.toUtf8Bytes(`leg ${leg} csv`));
const TAMPERED = ethers.sha256(ethers.toUtf8Bytes("tampered"));
const BATCH = 2; // inside container 1; limit 4.0 °C, grace 15 min

/** A passing quality check: 3.0 °C, nothing unrefrigerated, sealed, no issues. */
const OK = { tempTenthsC: 30, unrefrigeratedMinutes: 0, damaged: false, sealIntact: true, issues: false, notesHash: ethers.ZeroHash };
type Check = typeof OK;
const FLAG = { SENSOR: 1n, RECEIPT_TEMP: 2n, UNREFRIGERATED: 4n, CONDITION: 8n };
const Pass = { Pass: 0n, Flagged: 1n };
const Outcome = { Upheld: 0, Overturned: 1, CompensationAgreed: 2 };
const Cert = { None: 0n, Clean: 1n, Flagged: 2n, Resolved: 3n };
const Disposition = { None: 0, Released: 1, Rejected: 2 };

describe("CertificateRegistry", function () {
  /**
   * Deploys everything and runs batch 2 from origin to the buyer. `checks[stage]` overrides the
   * outgoing/incoming check at the handover that closes that stage (0 = origin dispatch ... 4 = truck → buyer).
   * No sensor evidence is reported yet.
   */
  async function deliver(checks: Partial<Record<number, { out?: Partial<Check>; in?: Partial<Check> }>> = {}, stopAfter = 4) {
    const [admin, oracle, certifier, device, importer, carrier, handler, coldStore, truck, buyer, inspector, stranger, otherInspector] =
      await ethers.getSigners();
    const registry = await ethers.deployContract("ParticipantRegistry", [admin.address]);
    const custody = await ethers.deployContract("ShipmentCustody", [await registry.getAddress()]);
    const sensors = await ethers.deployContract("SensorOracle", [await registry.getAddress(), await custody.getAddress()]);
    const certs = await ethers.deployContract("CertificateRegistry", [
      await registry.getAddress(),
      await custody.getAddress(),
      await sensors.getAddress(),
    ]);
    for (const [s, r] of [
      [oracle, "ORACLE"],
      [certifier, "CERTIFIER"],
      [importer, "IMPORTER"],
      [carrier, "CARRIER"],
      [handler, "HANDLER"],
      [coldStore, "COLD_STORE"],
      [truck, "TRUCK"],
      [buyer, "BUYER"],
      [inspector, "INSPECTOR"],
      [otherInspector, "INSPECTOR"],
    ] as const) {
      await registry.registerParticipant(s.address, role(r));
    }
    await sensors.registerSensor(bytes32("CTR"), device.address);
    await sensors.registerSensor(bytes32("B"), device.address);
    await custody.connect(importer).createContainer(bytes32("CTR"));
    await custody.connect(importer).addBatch(1, buyer.address, inspector.address, 40, 15, bytes32("B"));

    const handover = async (stage: number, unit: number, from: typeof admin, to: typeof admin) => {
      await custody.connect(from).initiateTransfer(unit, to.address, { ...OK, ...checks[stage]?.out });
      await custody.connect(to).acceptTransfer(unit, { ...OK, ...checks[stage]?.in });
    };
    const route = [
      () => handover(0, 1, importer, carrier),
      () => handover(1, 1, carrier, handler),
      async () => {
        await handover(2, 1, handler, coldStore);
        await custody.connect(coldStore).splitContainer(1);
      },
      () => handover(3, BATCH, coldStore, truck),
      () => handover(4, BATCH, truck, buyer),
    ];
    for (let stage = 0; stage <= stopAfter; stage++) await route[stage]();

    /** Sensor commits and oracle submits a leg summary with the given breach length. */
    const report = async (leg: number, breachMinutes = 0, submittedHash = fileHash(leg)) => {
      if ((await sensors.committedHash(leg <= 3 ? 1 : BATCH, leg)) === ethers.ZeroHash) {
        await sensors.connect(device).commitFileHash(BATCH, leg, fileHash(leg));
      }
      const breach = breachMinutes > 0 ? [1000, 1000 + breachMinutes * 60] : [0, 0];
      await sensors.connect(oracle).submitLegSummary(BATCH, leg, submittedHash, 20, breachMinutes ? 74 : 35, breachMinutes, breach[0], breach[1]);
    };

    /** What the Certificate Service's sync does: claims for flagged stages, then leg passes. */
    const certifyAll = async (sensorBreaches: number[] = [0, 0, 0, 0]) => {
      for (let leg = 1; leg <= 4; leg++) await report(leg, sensorBreaches[leg - 1]);
      for (let stage = 0; stage <= 4; stage++) {
        if ((await certs.stageFlags(BATCH, stage)).flags !== 0n) await certs.connect(certifier).openClaim(BATCH, stage);
        await certs.connect(certifier).issueLegPass(BATCH, stage);
      }
    };

    return { registry, custody, sensors, certs, certifier, importer, carrier, handler, coldStore, buyer, inspector, stranger, otherInspector, report, certifyAll };
  }

  describe("stage flags", function () {
    it("a clean journey has no flags at any stage", async function () {
      const { certs, report } = await deliver();
      for (let leg = 1; leg <= 4; leg++) await report(leg);
      for (let stage = 0; stage <= 4; stage++) {
        const f = await certs.stageFlags(BATCH, stage);
        expect(f.flags).to.equal(0n);
        expect(f.checkpointDone).to.equal(true);
        expect(f.sensorDone).to.equal(true);
      }
    });

    it("receipt temperature above the batch's limit", async function () {
      const { certs } = await deliver({ 1: { in: { tempTenthsC: 41 } }, 2: { in: { tempTenthsC: 40 } } });
      expect((await certs.stageFlags(BATCH, 1)).flags).to.equal(FLAG.RECEIPT_TEMP);
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(0n, "exactly at the limit passes");
    });

    it("sender's plus handover minutes without refrigeration above the grace period", async function () {
      const { certs } = await deliver({
        2: { out: { unrefrigeratedMinutes: 10 }, in: { unrefrigeratedMinutes: 6 } }, // 16 > 15
        3: { out: { unrefrigeratedMinutes: 10 }, in: { unrefrigeratedMinutes: 5 } }, // 15: passes
      });
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(FLAG.UNREFRIGERATED);
      expect((await certs.stageFlags(BATCH, 3)).flags).to.equal(0n);
    });

    it("damage, a broken seal, accepting with issues, or issues the sender reported", async function () {
      const { certs } = await deliver({
        0: { in: { damaged: true } },
        1: { in: { sealIntact: false } },
        2: { in: { issues: true } },
        3: { out: { issues: true } },
      });
      for (const stage of [0, 1, 2, 3]) expect((await certs.stageFlags(BATCH, stage)).flags).to.equal(FLAG.CONDITION);
      expect((await certs.stageFlags(BATCH, 4)).flags).to.equal(0n);
    });

    it("the sensor log's excursion longer than the grace period", async function () {
      const { certs, report } = await deliver();
      await report(2, 34);
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(FLAG.SENSOR);
    });

    it("reasons combine", async function () {
      const { certs, report } = await deliver({ 2: { in: { tempTenthsC: 72, issues: true } } });
      await report(2, 34);
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(FLAG.SENSOR | FLAG.RECEIPT_TEMP | FLAG.CONDITION);
    });
  });

  describe("claims", function () {
    it("open as soon as a handover is flagged, while the batch is still in transit", async function () {
      // The carrier finds the goods warm at pickup: a problem at origin, before any sensor log exists.
      const { certs, certifier, importer } = await deliver({ 0: { in: { tempTenthsC: 72 } } }, 0);
      await expect(certs.connect(certifier).openClaim(BATCH, 0))
        .to.emit(certs, "ClaimOpened")
        .withArgs(1, BATCH, 0, importer.address, FLAG.RECEIPT_TEMP);
      expect(await certs.openClaimCount(BATCH)).to.equal(1n);
    });

    it("are tagged to whoever held the batch on that stage", async function () {
      const { certs, certifier, handler, coldStore } = await deliver({ 2: { in: { tempTenthsC: 70 } }, 3: { in: { damaged: true } } });
      await certs.connect(certifier).openClaim(BATCH, 2);
      await certs.connect(certifier).openClaim(BATCH, 3);
      expect((await certs.getClaim(1)).provisionalCustodian).to.equal(handler.address);
      expect((await certs.getClaim(2)).provisionalCustodian).to.equal(coldStore.address);
    });

    it("can't be opened for an unflagged stage, or twice", async function () {
      const { certs, certifier } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await expect(certs.connect(certifier).openClaim(BATCH, 2)).to.be.revertedWith("stage not flagged");
      await certs.connect(certifier).openClaim(BATCH, 1);
      await expect(certs.connect(certifier).openClaim(BATCH, 1)).to.be.revertedWith("claim already open");
    });

    it("only the certifier opens claims", async function () {
      const { certs, stranger } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await expect(certs.connect(stranger).openClaim(BATCH, 1)).to.be.revertedWith("not the certifier");
    });
  });

  describe("leg passes", function () {
    it("need the closing checkpoint, and for legs 1-4 a verified sensor log", async function () {
      const { certs, certifier, report } = await deliver({}, 2); // still at the cold store
      await expect(certs.connect(certifier).issueLegPass(BATCH, 3)).to.be.revertedWith("handover checkpoint missing");
      await certs.connect(certifier).issueLegPass(BATCH, 0); // origin: checkpoint only
      await expect(certs.connect(certifier).issueLegPass(BATCH, 1)).to.be.revertedWith("evidence not verified");
      await report(1);
      await certs.connect(certifier).issueLegPass(BATCH, 1);
    });

    it("are BLOCKED while the sensor log's hash mismatches", async function () {
      const { certs, certifier, report } = await deliver();
      await report(1, 0, TAMPERED);
      await expect(certs.connect(certifier).issueLegPass(BATCH, 1)).to.be.revertedWith("evidence not verified");
      await report(1);
      await certs.connect(certifier).issueLegPass(BATCH, 1);
    });

    it("record the verdict, its reasons, the receipt temperature and unrefrigerated time", async function () {
      const { certs, certifier, handler, report } = await deliver({ 2: { out: { unrefrigeratedMinutes: 9 }, in: { tempTenthsC: 72, unrefrigeratedMinutes: 8 } } });
      await report(2, 34);
      await certs.connect(certifier).openClaim(BATCH, 2);
      await expect(certs.connect(certifier).issueLegPass(BATCH, 2))
        .to.emit(certs, "LegPassIssued")
        .withArgs(1, BATCH, 2, Pass.Flagged, FLAG.SENSOR | FLAG.RECEIPT_TEMP | FLAG.UNREFRIGERATED);
      const lp = await certs.getLegPass(1);
      expect(lp.custodian).to.equal(handler.address);
      expect(lp.receiptTenthsC).to.equal(72n);
      expect(lp.unrefrigeratedMinutes).to.equal(17n);
      expect(lp.breachMinutes).to.equal(34n);
      await expect(certs.connect(certifier).issueLegPass(BATCH, 2)).to.be.revertedWith("leg pass already issued");
    });
  });

  describe("final certificate", function () {
    it("REJECTS issuing before every stage has reported", async function () {
      const { certs, certifier, report } = await deliver({}, 3);
      for (let leg = 1; leg <= 3; leg++) await report(leg);
      for (let stage = 0; stage <= 3; stage++) await certs.connect(certifier).issueLegPass(BATCH, stage);
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH)).to.be.revertedWith("not every stage has reported");
    });

    it("is Clean when all five stages passed", async function () {
      const { certs, certifier, certifyAll } = await deliver();
      await certifyAll();
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH))
        .to.emit(certs, "FinalCertificateIssued")
        .withArgs(BATCH, Cert.Clean);
      expect((await certs.getCertificate(BATCH)).legPassIds).to.deep.equal([1n, 2n, 3n, 4n, 5n]);
    });

    it("is Flagged when any stage is, and needs that stage's claim first", async function () {
      const { certs, certifier, report } = await deliver({ 0: { in: { damaged: true } } });
      for (let leg = 1; leg <= 4; leg++) await report(leg);
      for (let stage = 0; stage <= 4; stage++) await certs.connect(certifier).issueLegPass(BATCH, stage);
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH)).to.be.revertedWith(
        "open a claim for every flagged stage first",
      );
      await certs.connect(certifier).openClaim(BATCH, 0);
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH))
        .to.emit(certs, "FinalCertificateIssued")
        .withArgs(BATCH, Cert.Flagged);
    });
  });

  describe("QA rulings on flagged stages", function () {
    it("REJECTS a ruling from anyone but the batch's assigned inspector", async function () {
      const { certs, certifyAll, stranger, otherInspector, buyer } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await certifyAll();
      for (const who of [stranger, otherInspector, buyer]) {
        await expect(certs.connect(who).submitResolution(1, Outcome.Upheld, "nope")).to.be.revertedWith("not the assigned inspector");
      }
    });

    it("can be made while the batch is still in transit", async function () {
      const { certs, certifier, inspector } = await deliver({ 1: { in: { tempTenthsC: 70 } } }, 1);
      await certs.connect(certifier).openClaim(BATCH, 1);
      await certs.connect(inspector).submitResolution(1, Outcome.Upheld, "Carrier's reefer failed; confirmed with their log");
      expect(await certs.openClaimCount(BATCH)).to.equal(0n);
    });

    it("ruling on the last open claim moves the certificate from Flagged to Resolved", async function () {
      const { certs, certifier, certifyAll, inspector } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await certifyAll([0, 34, 0, 0]); // also a sensor breach on leg 2 → two claims
      await certs.connect(certifier).issueFinalCertificate(BATCH);

      await certs.connect(inspector).submitResolution(1, Outcome.CompensationAgreed, "Carrier agreed a 10% credit");
      expect((await certs.getCertificate(BATCH)).status).to.equal(Cert.Flagged);
      await expect(certs.connect(inspector).submitResolution(2, Outcome.Overturned, "Logger against the door seal"))
        .to.emit(certs, "CertificateStatusChanged")
        .withArgs(BATCH, Cert.Resolved);
      expect((await certs.getCertificate(BATCH)).resolutionIds).to.deep.equal([1n, 2n]);
    });

    it("one ruling per claim, with a note of 1-1000 bytes", async function () {
      const { certs, certifyAll, inspector } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await certifyAll();
      await expect(certs.connect(inspector).submitResolution(1, Outcome.Upheld, "")).to.be.revertedWith("note must be 1-1000 bytes");
      await certs.connect(inspector).submitResolution(1, Outcome.Upheld, "ok");
      await expect(certs.connect(inspector).submitResolution(1, Outcome.Overturned, "again")).to.be.revertedWith(
        "claim already resolved",
      );
    });
  });

  describe("QA final decision and buyer acknowledgement", function () {
    it("only the assigned inspector decides, after the certificate and every ruling", async function () {
      const { certs, certifier, certifyAll, inspector, otherInspector } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await certifyAll();
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "ok")).to.be.revertedWith(
        "no final certificate yet",
      );
      await certs.connect(certifier).issueFinalCertificate(BATCH);
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "ok")).to.be.revertedWith(
        "rule on every flagged stage first",
      );
      await certs.connect(inspector).submitResolution(1, Outcome.Upheld, "Carrier responsible");
      await expect(certs.connect(otherInspector).submitDisposition(BATCH, Disposition.Released, "ok")).to.be.revertedWith(
        "not the assigned inspector",
      );
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.None, "ok")).to.be.revertedWith(
        "choose release or reject",
      );

      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Rejected, "Core temp 7 °C on arrival; not sellable"))
        .to.emit(certs, "DispositionSubmitted")
        .withArgs(BATCH, inspector.address, Disposition.Rejected);
      const d = await certs.getDecision(BATCH);
      expect(d.disposition).to.equal(BigInt(Disposition.Rejected));
      expect(d.note).to.equal("Core temp 7 °C on arrival; not sellable");
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "changed mind")).to.be.revertedWith(
        "already decided",
      );
    });

    it("REJECTS acknowledgement from anyone but the batch's buyer, and before QA decides", async function () {
      const { certs, certifier, certifyAll, buyer, inspector, stranger } = await deliver();
      await certifyAll();
      await certs.connect(certifier).issueFinalCertificate(BATCH);
      await expect(certs.connect(buyer).acknowledgeReceipt(BATCH)).to.be.revertedWith("awaiting QA decision");
      await certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "All five checkpoints passed");
      for (const who of [stranger, inspector]) {
        await expect(certs.connect(who).acknowledgeReceipt(BATCH)).to.be.revertedWith("not the batch's buyer");
      }
      await expect(certs.connect(buyer).acknowledgeReceipt(BATCH)).to.emit(certs, "ReceiptAcknowledged").withArgs(BATCH, buyer.address);
      await expect(certs.connect(buyer).acknowledgeReceipt(BATCH)).to.be.revertedWith("already acknowledged");
    });
  });

  it("everything stops while paused", async function () {
    const { registry, certs, certifier } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
    await registry.pause();
    await expect(certs.connect(certifier).openClaim(BATCH, 1)).to.be.revertedWith("system paused");
  });
});
