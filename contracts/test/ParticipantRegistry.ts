import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const role = (name: string) => ethers.id(name);

describe("ParticipantRegistry", function () {
  async function deploy() {
    const [admin, supplier, stranger] = await ethers.getSigners();
    const registry = await ethers.deployContract("ParticipantRegistry", [admin.address]);
    return { registry, admin, supplier, stranger };
  }

  it("lets the admin register a participant with a role", async function () {
    const { registry, supplier } = await deploy();

    await expect(registry.registerParticipant(supplier.address, role("SUPPLIER")))
      .to.emit(registry, "ParticipantRegistered")
      .withArgs(supplier.address, role("SUPPLIER"));

    expect(await registry.hasRole(role("SUPPLIER"), supplier.address)).to.equal(true);
    expect(await registry.roleOf(supplier.address)).to.equal(role("SUPPLIER"));
  });

  it("rejects registration from a non-admin", async function () {
    const { registry, supplier, stranger } = await deploy();

    await expect(
      registry.connect(stranger).registerParticipant(supplier.address, role("SUPPLIER")),
    ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
  });

  it("rejects unknown roles and double registration", async function () {
    const { registry, supplier } = await deploy();

    await expect(registry.registerParticipant(supplier.address, role("PIRATE"))).to.be.revertedWith("unknown role");

    await registry.registerParticipant(supplier.address, role("SUPPLIER"));
    await expect(registry.registerParticipant(supplier.address, role("BUYER"))).to.be.revertedWith(
      "already registered",
    );
  });

  it("suspending removes the role", async function () {
    const { registry, supplier } = await deploy();
    await registry.registerParticipant(supplier.address, role("SUPPLIER"));

    await registry.suspendParticipant(supplier.address);

    expect(await registry.hasRole(role("SUPPLIER"), supplier.address)).to.equal(false);
    expect(await registry.roleOf(supplier.address)).to.equal(ethers.ZeroHash);
  });

  it("blocks direct grantRole / revokeRole / renounceRole", async function () {
    const { registry, supplier } = await deploy();
    await registry.registerParticipant(supplier.address, role("SUPPLIER"));

    await expect(registry.grantRole(role("BUYER"), supplier.address)).to.be.revertedWith("use registerParticipant");
    await expect(registry.revokeRole(role("SUPPLIER"), supplier.address)).to.be.revertedWith("use suspendParticipant");
    await expect(
      registry.connect(supplier).renounceRole(role("SUPPLIER"), supplier.address),
    ).to.be.revertedWith("ask the admin to suspend");
  });

  it("admin can pause; registration is blocked while paused", async function () {
    const { registry, supplier, stranger } = await deploy();

    await expect(registry.connect(stranger).pause()).to.be.revertedWithCustomError(
      registry,
      "AccessControlUnauthorizedAccount",
    );

    await registry.pause();
    expect(await registry.paused()).to.equal(true);
    await expect(registry.registerParticipant(supplier.address, role("SUPPLIER"))).to.be.revertedWithCustomError(
      registry,
      "EnforcedPause",
    );

    await registry.unpause();
    await registry.registerParticipant(supplier.address, role("SUPPLIER"));
  });
});
