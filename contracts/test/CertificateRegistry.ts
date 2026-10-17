import { expect } from "chai";
import { network } from "hardhat";
import { type Checks, deploy } from "./fixtures.ts";

const { ethers, networkHelpers } = await network.create();

const fileHash = (stage: number) => ethers.sha256(ethers.toUtf8Bytes(`stage ${stage} readings`));
const TAMPERED = ethers.sha256(ethers.toUtf8Bytes("edited readings"));
const FLAG = { SENSOR: 1n, RECEIPT_TEMP: 2n, HANDOVER_GAP: 4n, CONDITION: 8n, MISSING_DATA: 16n };
const Pass = { Pass: 0n, Flagged: 1n };
const Outcome = { Upheld: 0, Overturned: 1, CompensationAgreed: 2 };
const Cert = { None: 0n, Clean: 1n, Flagged: 2n, Resolved: 3n };
const Disposition = { None: 0, Released: 1, Rejected: 2 };

describe("CertificateRegistry", function () {
  /**
   * Runs one batch (limit 4.0 °C, 15 min grace) from the supplier to the buyer, stopping after
   * stage `stopAfter`. `checks[stage]` overrides that handover's checks and dock time. No sensor
   * readings are reported yet.
   */
  async function deliver(checks: Checks = {}, stopAfter = 4) {
    const f = await deploy(ethers, (s) => networkHelpers.time.increase(s));
    const batch = await f.newBatch();
    const container = await f.newContainer();
    const route = [
      () => f.toCargo(batch, container, checks),
      () => f.toHandler(container, checks),
      () => f.toColdStore(container, checks),
      () => f.toTruck(batch, checks),
      () => f.toBuyer(batch, checks),
    ];
    for (let stage = 0; stage <= stopAfter; stage++) await route[stage]();

    /** The sensor commits its readings for the stage; the oracle submits the batch's summary. */
    const report = async (stage: number, breachMinutes = 0, missingMinutes = 0, submitted = fileHash(stage)) => {
      const unit = Number(await f.custody.recordedOn(batch, stage));
      if ((await f.sensors.committedHash(unit, stage)) === ethers.ZeroHash) {
        await f.sensors.connect(f.device).commitFileHash(unit, stage, fileHash(stage));
      }
      const breach = breachMinutes > 0 ? [1000, 1000 + breachMinutes * 60] : [0, 0];
      await f.sensors
        .connect(f.oracle)
        .submitLegSummary(batch, stage, submitted, 20, breachMinutes ? 74 : 35, breachMinutes, missingMinutes, breach[0], breach[1]);
    };

    /** What the Certificate Service's sync does: claims for flagged stages, then a leg pass per stage. */
    const certifyAll = async (sensorBreaches: number[] = [0, 0, 0, 0, 0]) => {
      for (let stage = 0; stage <= 4; stage++) await report(stage, sensorBreaches[stage]);
      for (let stage = 0; stage <= 4; stage++) {
        if ((await f.certs.stageFlags(batch, stage)).flags !== 0n) await f.certs.connect(f.certifier).openClaim(batch, stage);
        await f.certs.connect(f.certifier).issueLegPass(batch, stage);
      }
    };

    return { ...f, BATCH: batch, report, certifyAll };
  }

  describe("stage flags", function () {
    it("a clean journey has no flags at any of the five stages", async function () {
      const { certs, report, BATCH } = await deliver();
      for (let stage = 0; stage <= 4; stage++) await report(stage);
      for (let stage = 0; stage <= 4; stage++) {
        const f = await certs.stageFlags(BATCH, stage);
        expect(f.flags).to.equal(0n);
        expect(f.checkpointDone).to.equal(true);
        expect(f.sensorDone).to.equal(true);
      }
    });

    it("receipt temperature above the batch's limit", async function () {
      const { certs, BATCH } = await deliver({ 1: { in: { tempTenthsC: 41 } }, 2: { in: { tempTenthsC: 40 } } });
      expect((await certs.stageFlags(BATCH, 1)).flags).to.equal(FLAG.RECEIPT_TEMP);
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(0n, "exactly at the limit passes");
    });

    it("a handover gap (sign-off to sign-in, unrefrigerated) longer than the grace period", async function () {
      const { certs, BATCH } = await deliver({
        0: { gapSeconds: 16 * 60 - 1 }, // + the sign-in's own block: 16 minutes > 15
        2: { gapSeconds: 15 * 60 - 1 }, // 15 minutes: passes
        1: { gapSeconds: 60 * 60 }, // the container's sensor keeps reading: never a gap
      });
      expect((await certs.stageFlags(BATCH, 0)).flags).to.equal(FLAG.HANDOVER_GAP);
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(0n);
      expect((await certs.stageFlags(BATCH, 1)).flags).to.equal(0n);
    });

    it("damage, a broken seal, accepting with issues, or issues the sender reported", async function () {
      const { certs, BATCH } = await deliver({
        0: { in: { damaged: true } },
        1: { in: { sealIntact: false } },
        2: { in: { issues: true } },
        3: { out: { issues: true } },
      });
      for (const stage of [0, 1, 2, 3]) expect((await certs.stageFlags(BATCH, stage)).flags).to.equal(FLAG.CONDITION);
      expect((await certs.stageFlags(BATCH, 4)).flags).to.equal(0n);
    });

    it("the sensor's excursion longer than the grace period, at any stage including the supplier's", async function () {
      const { certs, report, BATCH } = await deliver();
      await report(0, 34);
      await report(2, 15);
      expect((await certs.stageFlags(BATCH, 0)).flags).to.equal(FLAG.SENSOR);
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(0n, "exactly the grace period passes");
    });

    it("minutes with no sensor readings longer than the grace period", async function () {
      const { certs, report, BATCH } = await deliver();
      await report(3, 0, 20);
      expect((await certs.stageFlags(BATCH, 3)).flags).to.equal(FLAG.MISSING_DATA);
    });

    it("reasons combine", async function () {
      const { certs, report, BATCH } = await deliver({ 2: { in: { tempTenthsC: 72, issues: true } } });
      await report(2, 34);
      expect((await certs.stageFlags(BATCH, 2)).flags).to.equal(FLAG.SENSOR | FLAG.RECEIPT_TEMP | FLAG.CONDITION);
    });
  });

  describe("claims", function () {
    it("open as soon as a handover is flagged, while the batch is still in transit, against the supplier at origin", async function () {
      const { certs, certifier, supplier, BATCH } = await deliver({ 0: { in: { tempTenthsC: 72 } } }, 0);
      await expect(certs.connect(certifier).openClaim(BATCH, 0))
        .to.emit(certs, "ClaimOpened")
        .withArgs(1, BATCH, 0, supplier.address, FLAG.RECEIPT_TEMP);
      expect(await certs.openClaimCount(BATCH)).to.equal(1n);
    });

    it("are tagged to whoever held the batch on that stage", async function () {
      const { certs, certifier, handler, coldStore, BATCH } = await deliver({ 2: { in: { tempTenthsC: 70 } }, 3: { in: { damaged: true } } });
      await certs.connect(certifier).openClaim(BATCH, 2);
      await certs.connect(certifier).openClaim(BATCH, 3);
      expect((await certs.getClaim(1)).provisionalCustodian).to.equal(handler.address);
      expect((await certs.getClaim(2)).provisionalCustodian).to.equal(coldStore.address);
    });

    it("can't be opened for an unflagged stage, or twice, and only by the certifier", async function () {
      const { certs, certifier, stranger, BATCH } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await expect(certs.connect(certifier).openClaim(BATCH, 2)).to.be.revertedWith("stage not flagged");
      await expect(certs.connect(stranger).openClaim(BATCH, 1)).to.be.revertedWith("not the certifier");
      await certs.connect(certifier).openClaim(BATCH, 1);
      await expect(certs.connect(certifier).openClaim(BATCH, 1)).to.be.revertedWith("claim already open");
    });
  });

  describe("leg passes", function () {
    it("need the closing handover and the stage's verified sensor readings", async function () {
      const { certs, certifier, report, BATCH } = await deliver({}, 2); // at the cold store
      await expect(certs.connect(certifier).issueLegPass(BATCH, 3)).to.be.revertedWith("handover checkpoint missing");
      await expect(certs.connect(certifier).issueLegPass(BATCH, 0)).to.be.revertedWith("evidence not verified");
      await report(0);
      await certs.connect(certifier).issueLegPass(BATCH, 0);
    });

    it("are BLOCKED while the readings don't match the sensor's commit", async function () {
      const { certs, certifier, report, BATCH } = await deliver();
      await report(1, 0, 0, TAMPERED);
      await expect(certs.connect(certifier).issueLegPass(BATCH, 1)).to.be.revertedWith("evidence not verified");
      await report(1);
      await certs.connect(certifier).issueLegPass(BATCH, 1);
    });

    it("record the verdict, its reasons, the receipt temperature and the handover gap", async function () {
      const { certs, certifier, handler, report, BATCH } = await deliver({ 2: { in: { tempTenthsC: 72 }, gapSeconds: 20 * 60 - 1 } });
      await report(2, 34);
      await certs.connect(certifier).openClaim(BATCH, 2);
      await expect(certs.connect(certifier).issueLegPass(BATCH, 2))
        .to.emit(certs, "LegPassIssued")
        .withArgs(1, BATCH, 2, Pass.Flagged, FLAG.SENSOR | FLAG.RECEIPT_TEMP | FLAG.HANDOVER_GAP);
      const lp = await certs.getLegPass(1);
      expect(lp.custodian).to.equal(handler.address);
      expect(lp.receiptTenthsC).to.equal(72n);
      expect(lp.gapMinutes).to.equal(20n);
      expect(lp.breachMinutes).to.equal(34n);
      await expect(certs.connect(certifier).issueLegPass(BATCH, 2)).to.be.revertedWith("leg pass already issued");
    });
  });

  describe("final certificate", function () {
    it("REJECTS issuing before every stage has reported", async function () {
      const { certs, certifier, report, BATCH } = await deliver({}, 3);
      for (let stage = 0; stage <= 3; stage++) {
        await report(stage);
        await certs.connect(certifier).issueLegPass(BATCH, stage);
      }
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH)).to.be.revertedWith("not every stage has reported");
    });

    it("is Clean when all five stages passed", async function () {
      const { certs, certifier, certifyAll, BATCH } = await deliver();
      await certifyAll();
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH)).to.emit(certs, "FinalCertificateIssued").withArgs(BATCH, Cert.Clean);
      expect((await certs.getCertificate(BATCH)).legPassIds).to.deep.equal([1n, 2n, 3n, 4n, 5n]);
    });

    it("is Flagged when any stage is, and needs that stage's claim first", async function () {
      const { certs, certifier, report, BATCH } = await deliver({ 0: { in: { damaged: true } } });
      for (let stage = 0; stage <= 4; stage++) {
        await report(stage);
        await certs.connect(certifier).issueLegPass(BATCH, stage);
      }
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH)).to.be.revertedWith("open a claim for every flagged stage first");
      await certs.connect(certifier).openClaim(BATCH, 0);
      await expect(certs.connect(certifier).issueFinalCertificate(BATCH)).to.emit(certs, "FinalCertificateIssued").withArgs(BATCH, Cert.Flagged);
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
      const { certs, certifier, inspector, BATCH } = await deliver({ 1: { in: { tempTenthsC: 70 } } }, 1);
      await certs.connect(certifier).openClaim(BATCH, 1);
      await certs.connect(inspector).submitResolution(1, Outcome.Upheld, "Cargo's reefer failed; confirmed with their sensor");
      expect(await certs.openClaimCount(BATCH)).to.equal(0n);
    });

    it("ruling on the last open claim moves the certificate from Flagged to Resolved", async function () {
      const { certs, certifier, certifyAll, inspector, BATCH } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await certifyAll([0, 0, 34, 0, 0]); // also a sensor breach at stage 2 → two claims
      await certs.connect(certifier).issueFinalCertificate(BATCH);

      await certs.connect(inspector).submitResolution(1, Outcome.CompensationAgreed, "Cargo agreed a 10% credit");
      expect((await certs.getCertificate(BATCH)).status).to.equal(Cert.Flagged);
      await expect(certs.connect(inspector).submitResolution(2, Outcome.Overturned, "Sensor against the door seal"))
        .to.emit(certs, "CertificateStatusChanged")
        .withArgs(BATCH, Cert.Resolved);
      expect((await certs.getCertificate(BATCH)).resolutionIds).to.deep.equal([1n, 2n]);
    });

    it("one ruling per claim, with a note of 1-1000 bytes", async function () {
      const { certs, certifyAll, inspector } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await certifyAll();
      await expect(certs.connect(inspector).submitResolution(1, Outcome.Upheld, "")).to.be.revertedWith("note must be 1-1000 bytes");
      await certs.connect(inspector).submitResolution(1, Outcome.Upheld, "ok");
      await expect(certs.connect(inspector).submitResolution(1, Outcome.Overturned, "again")).to.be.revertedWith("claim already resolved");
    });
  });

  describe("QA final decision and buyer acknowledgement", function () {
    it("only the assigned inspector decides, after the certificate and every ruling", async function () {
      const { certs, certifier, certifyAll, inspector, otherInspector, BATCH } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
      await certifyAll();
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "ok")).to.be.revertedWith("no final certificate yet");
      await certs.connect(certifier).issueFinalCertificate(BATCH);
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "ok")).to.be.revertedWith(
        "rule on every flagged stage first",
      );
      await certs.connect(inspector).submitResolution(1, Outcome.Upheld, "Cargo responsible");
      await expect(certs.connect(otherInspector).submitDisposition(BATCH, Disposition.Released, "ok")).to.be.revertedWith(
        "not the assigned inspector",
      );
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.None, "ok")).to.be.revertedWith("choose release or reject");

      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Rejected, "Core temp 7 °C on arrival; not sellable"))
        .to.emit(certs, "DispositionSubmitted")
        .withArgs(BATCH, inspector.address, Disposition.Rejected);
      const d = await certs.getDecision(BATCH);
      expect(d.disposition).to.equal(BigInt(Disposition.Rejected));
      expect(d.note).to.equal("Core temp 7 °C on arrival; not sellable");
      await expect(certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "changed mind")).to.be.revertedWith("already decided");
    });

    it("REJECTS acknowledgement from anyone but the batch's buyer, and before QA decides", async function () {
      const { certs, certifier, certifyAll, buyer, inspector, stranger, BATCH } = await deliver();
      await certifyAll();
      await certs.connect(certifier).issueFinalCertificate(BATCH);
      await expect(certs.connect(buyer).acknowledgeReceipt(BATCH)).to.be.revertedWith("awaiting QA decision");
      await certs.connect(inspector).submitDisposition(BATCH, Disposition.Released, "All five stages passed");
      for (const who of [stranger, inspector]) {
        await expect(certs.connect(who).acknowledgeReceipt(BATCH)).to.be.revertedWith("not the batch's buyer");
      }
      await expect(certs.connect(buyer).acknowledgeReceipt(BATCH)).to.emit(certs, "ReceiptAcknowledged").withArgs(BATCH, buyer.address);
      await expect(certs.connect(buyer).acknowledgeReceipt(BATCH)).to.be.revertedWith("already acknowledged");
    });
  });

  it("everything stops while paused", async function () {
    const { registry, certs, certifier, BATCH } = await deliver({ 1: { in: { tempTenthsC: 70 } } });
    await registry.pause();
    await expect(certs.connect(certifier).openClaim(BATCH, 1)).to.be.revertedWith("system paused");
  });
});
