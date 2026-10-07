// Deploys the ColdChainSG contracts and writes addresses + ABIs to
// ../deployments/<network>.json, which every backend service and the frontend read.
//
//   npm run deploy:local     (needs `npm run chain` running)
//   npm run deploy:sepolia   (optional)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";

const { ethers, networkName } = await network.getOrCreate();
const root = join(import.meta.dirname, "..", "..");

// Service wallets. On localhost these default to Hardhat accounts #1 and #2.
const signers = await ethers.getSigners();
const admin = signers[0];
const oracleAddress = process.env.ORACLE_ADDRESS ?? signers[1].address;
const certifierAddress = process.env.CERTIFIER_ADDRESS ?? signers[2].address;

console.log(`Deploying to ${networkName} as admin ${admin.address}`);

const registry = await ethers.deployContract("ParticipantRegistry", [admin.address]);
await registry.waitForDeployment();

await (await registry.registerParticipant(oracleAddress, ethers.id("ORACLE"))).wait();
await (await registry.registerParticipant(certifierAddress, ethers.id("CERTIFIER"))).wait();

const custody = await ethers.deployContract("ShipmentCustody", [await registry.getAddress()]);
await custody.waitForDeployment();

const sensorOracle = await ethers.deployContract("SensorOracle", [
  await registry.getAddress(),
  await custody.getAddress(),
]);
await sensorOracle.waitForDeployment();

const certificates = await ethers.deployContract("CertificateRegistry", [
  await registry.getAddress(),
  await custody.getAddress(),
  await sensorOracle.getAddress(),
]);
await certificates.waitForDeployment();

const deployed: Record<string, string> = {
  ParticipantRegistry: await registry.getAddress(),
  ShipmentCustody: await custody.getAddress(),
  SensorOracle: await sensorOracle.getAddress(),
  CertificateRegistry: await certificates.getAddress(),
};

function abiOf(name: string) {
  const artifact = JSON.parse(
    readFileSync(join(root, "contracts", "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf8"),
  );
  return artifact.abi;
}

const output = {
  network: networkName,
  chainId: Number((await ethers.provider.getNetwork()).chainId),
  deployedAt: new Date().toISOString(),
  contracts: Object.fromEntries(
    Object.entries(deployed).map(([name, address]) => [name, { address, abi: abiOf(name) }]),
  ),
};

mkdirSync(join(root, "deployments"), { recursive: true });
const outFile = join(root, "deployments", `${networkName}.json`);
writeFileSync(outFile, JSON.stringify(output, null, 2));

for (const [name, address] of Object.entries(deployed)) console.log(`  ${name.padEnd(22)} ${address}`);
console.log(`Wrote ${outFile}`);
