import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const role = (name: string) => ethers.id(name);

describe("ParticipantRegistry", function () {
  async function deploy() {
    const [admin, importer, stranger] = await ethers.getSigners();
    const registry = await ethers.deployContract("ParticipantRegistry", [admin.address]);
    return { registry, admin, importer, stranger };
  }

  it("lets the admin register a participant with a role", async function () {
    const { registry, importer } = await deploy();

    await expect(registry.registerParticipant(importer.address, role("IMPORTER")))
      .to.emit(registry, "ParticipantRegistered")
      .withArgs(importer.address, role("IMPORTER"));

    expect(await registry.hasRole(role("IMPORTER"), importer.address)).to.equal(true);
    expect(await registry.roleOf(importer.address)).to.equal(role("IMPORTER"));
  });

  it("rejects registration from a non-admin", async function () {
    const { registry, importer, stranger } = await deploy();

    await expect(
      registry.connect(stranger).registerParticipant(importer.address, role("IMPORTER")),
    ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
  });

  it("rejects unknown roles and double registration", async function () {
    const { registry, importer } = await deploy();

    await expect(registry.registerParticipant(importer.address, role("PIRATE"))).to.be.revertedWith("unknown role");

    await registry.registerParticipant(importer.address, role("IMPORTER"));
    await expect(registry.registerParticipant(importer.address, role("BUYER"))).to.be.revertedWith(
      "already registered",
    );
  });

  it("suspending removes the role", async function () {
    const { registry, importer } = await deploy();
    await registry.registerParticipant(importer.address, role("IMPORTER"));

    await registry.suspendParticipant(importer.address);

    expect(await registry.hasRole(role("IMPORTER"), importer.address)).to.equal(false);
    expect(await registry.roleOf(importer.address)).to.equal(ethers.ZeroHash);
  });

  it("blocks direct grantRole / revokeRole / renounceRole", async function () {
    const { registry, importer } = await deploy();
    await registry.registerParticipant(importer.address, role("IMPORTER"));

    await expect(registry.grantRole(role("BUYER"), importer.address)).to.be.revertedWith("use registerParticipant");
    await expect(registry.revokeRole(role("IMPORTER"), importer.address)).to.be.revertedWith("use suspendParticipant");
    await expect(
      registry.connect(importer).renounceRole(role("IMPORTER"), importer.address),
    ).to.be.revertedWith("ask the admin to suspend");
  });

  it("admin can pause; registration is blocked while paused", async function () {
    const { registry, importer, stranger } = await deploy();

    await expect(registry.connect(stranger).pause()).to.be.revertedWithCustomError(
      registry,
      "AccessControlUnauthorizedAccount",
    );

    await registry.pause();
    expect(await registry.paused()).to.equal(true);
    await expect(registry.registerParticipant(importer.address, role("IMPORTER"))).to.be.revertedWithCustomError(
      registry,
      "EnforcedPause",
    );

    await registry.unpause();
    await registry.registerParticipant(importer.address, role("IMPORTER"));
  });
});
