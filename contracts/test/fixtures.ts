// Shared fixtures for the contract tests: deploys the four contracts and walks a batch along the
// route the way the real parties would. Not a test file itself (it defines no tests).
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";

/** A passing handover check: 3.0 °C probe, no damage, seal intact, no issues. */
export const OK = { tempTenthsC: 30, damaged: false, sealIntact: true, issues: false, notesHash: "0x" + "00".repeat(32) };
export type Check = typeof OK;
/** Per stage: the sender's and receiver's check, and the seconds between sign-off and sign-in. */
export type Checks = Partial<Record<number, { out?: Partial<Check>; in?: Partial<Check>; gapSeconds?: number }>>;

export const AUTO = "0x" + "00".repeat(11); // no container number given: the contract generates one
export const Stage = { Origin: 0n, Carrier: 1n, Handler: 2n, ColdStore: 3n, Truck: 4n, Delivered: 5n };

export async function deploy(ethers: HardhatEthers, increaseTime?: (seconds: number) => Promise<unknown>) {
  const bytes32 = (s: string) => ethers.encodeBytes32String(s);
  const [admin, oracle, certifier, gateway, supplier, carrier, handler, coldStore, truck, buyer, inspector, otherBuyer, otherInspector, stranger] =
    await ethers.getSigners();

  const registry = await ethers.deployContract("ParticipantRegistry", [admin.address]);
  const custody = await ethers.deployContract("ShipmentCustody", [await registry.getAddress()]);
  const sensors = await ethers.deployContract("SensorOracle", [await registry.getAddress(), await custody.getAddress()]);
  const certs = await ethers.deployContract("CertificateRegistry", [
    await registry.getAddress(),
    await custody.getAddress(),
    await sensors.getAddress(),
  ]);

  for (const [signer, role] of [
    [oracle, "ORACLE"],
    [certifier, "CERTIFIER"],
    [supplier, "SUPPLIER"],
    [carrier, "CARRIER"],
    [handler, "HANDLER"],
    [coldStore, "COLD_STORE"],
    [truck, "TRUCK"],
    [buyer, "BUYER"],
    [otherBuyer, "BUYER"],
    [inspector, "INSPECTOR"],
    [otherInspector, "INSPECTOR"],
  ] as const) {
    await registry.registerParticipant(signer.address, ethers.id(role));
  }

  // Each party's own sensor. In the demo one gateway key signs for every simulated device.
  const SENSOR = {
    supplier: bytes32("SUP-ROOM-1"),
    container: bytes32("CTR-REEFER-1"),
    coldStore: bytes32("COLD-ROOM-1"),
    truck: bytes32("TRUCK-1"),
  };
  const device = gateway;
  const SEAL = bytes32("SGB4471203");

  const check = (c?: Partial<Check>) => ({ ...OK, ...c });
  /** Time on the dock between the sender's sign-off and the receiver's sign-in. */
  const gap = async (checks: Checks, stage: number) => {
    const seconds = checks[stage]?.gapSeconds;
    if (seconds) await increaseTime!(seconds);
  };

  /** The supplier creates a batch (limit 4.0 °C, 15 min grace by default) and registers its cold-room sensor. */
  async function newBatch(opts: { buyer?: typeof buyer; threshold?: number; grace?: number } = {}) {
    const id = Number(await custody.nextId());
    await custody.connect(supplier).createBatch((opts.buyer ?? buyer).address, inspector.address, opts.threshold ?? 40, opts.grace ?? 15);
    await custody.connect(supplier).registerSensor([id], SENSOR.supplier, device.address);
    return id;
  }

  /** Cargo opens a container and registers the container's sensor. */
  async function newContainer(code = AUTO) {
    const id = Number(await custody.nextId());
    await custody.connect(carrier).createContainer(code);
    await custody.connect(carrier).registerSensor([id], SENSOR.container, device.address);
    return id;
  }

  /** Stage 0 closes: supplier signs the batch off, Cargo receives it into the container. */
  async function toCargo(batchId: number, containerId: number, checks: Checks = {}) {
    await custody.connect(supplier).initiateTransfer(batchId, carrier.address, check(checks[0]?.out));
    await gap(checks, 0);
    await custody.connect(carrier).acceptIntoContainer(batchId, containerId, check(checks[0]?.in));
  }

  /** Stage 1 closes: Cargo seals the container and hands it to the destination freight handler. */
  async function toHandler(containerId: number, checks: Checks = {}) {
    await custody.connect(carrier).recordSeal(containerId, SEAL);
    await custody.connect(carrier).initiateTransfer(containerId, handler.address, check(checks[1]?.out));
    await gap(checks, 1);
    await custody.connect(handler).acceptTransfer(containerId, check(checks[1]?.in));
  }

  /** Stage 2 closes: the handler hands the container to the cold store, which registers its room sensor and unloads. */
  async function toColdStore(containerId: number, checks: Checks = {}) {
    await custody.connect(handler).initiateTransfer(containerId, coldStore.address, check(checks[2]?.out));
    await gap(checks, 2);
    await custody.connect(coldStore).acceptTransfer(containerId, check(checks[2]?.in));
    const batchIds = (await custody.getBatches(containerId)).map(Number);
    await custody.connect(coldStore).registerSensor(batchIds, SENSOR.coldStore, device.address);
    await custody.connect(coldStore).unloadContainer(containerId);
  }

  /** Stage 3 closes: the cold store signs a batch off to the reefer truck, which registers its sensor. */
  async function toTruck(batchId: number, checks: Checks = {}) {
    await custody.connect(coldStore).initiateTransfer(batchId, truck.address, check(checks[3]?.out));
    await gap(checks, 3);
    await custody.connect(truck).acceptTransfer(batchId, check(checks[3]?.in));
    await custody.connect(truck).registerSensor([batchId], SENSOR.truck, device.address);
  }

  /** Stage 4 closes: the truck delivers to the buyer. */
  async function toBuyer(batchId: number, checks: Checks = {}, to = buyer) {
    await custody.connect(truck).initiateTransfer(batchId, to.address, check(checks[4]?.out));
    await gap(checks, 4);
    await custody.connect(to).acceptTransfer(batchId, check(checks[4]?.in));
  }

  return {
    registry, custody, sensors, certs,
    admin, oracle, certifier, device, supplier, carrier, handler, coldStore, truck, buyer, inspector, otherBuyer, otherInspector, stranger,
    SENSOR, SEAL, newBatch, newContainer, toCargo, toHandler, toColdStore, toTruck, toBuyer,
  };
}
