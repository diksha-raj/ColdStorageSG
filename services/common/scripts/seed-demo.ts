// Onboards the demo organisations through the real flow (sign in → request access → admin
// approves on-chain) and registers the demo sensors. Safe to re-run: existing ones are skipped.
//
//   npm run seed      (needs the chain, a deployment, and the identity + oracle services running)
//
// Wallets are Hardhat's PUBLIC test accounts #4-#12 — fine for a local demo, never for real funds.
import { HDNodeWallet, Wallet } from "ethers";
import { env } from "../src/index.ts";
import { api, signIn } from "../src/testing.ts";

const MNEMONIC = "test test test test test test test test test test test junk"; // Hardhat default
const identity = api(`http://localhost:${env.IDENTITY_PORT}`);
const oracle = api(`http://localhost:${env.ORACLE_PORT}`);

const PERSONAS = [
  { account: 4, role: "IMPORTER", org: "Merlion Fresh Imports", email: "ops@merlionfresh.example" },
  { account: 5, role: "CARRIER", org: "Equator Air Cargo", email: "ops@equatorair.example" },
  { account: 6, role: "HANDLER", org: "Runway Cargo Handlers", email: "ops@runwaycargo.example" },
  { account: 7, role: "COLD_STORE", org: "Merlion Fresh Cold Store", email: "coldstore@merlionfresh.example" },
  { account: 8, role: "TRUCK", org: "Kallang Reefer Trucks", email: "dispatch@kallangreefer.example" },
  { account: 9, role: "BUYER", org: "Tiong Bahru Grocers", email: "orders@tbgrocers.example" },
  { account: 10, role: "INSPECTOR", org: "Tiong Bahru Grocers QA", email: "qa@tbgrocers.example" },
  { account: 11, role: "BUYER", org: "Marina Bay Dining Group", email: "orders@mbdining.example" },
  { account: 12, role: "INSPECTOR", org: "Marina Bay Dining QA", email: "qa@mbdining.example" },
] as const;

const SENSORS = [
  { sensorId: "SENS-CTR-01", label: "Reefer container logger" },
  { sensorId: "SENS-CTR-02", label: "Reefer container logger (spare)" },
  { sensorId: "SENS-B-01", label: "Batch logger" },
  { sensorId: "SENS-B-02", label: "Batch logger" },
  { sensorId: "SENS-B-03", label: "Batch logger" },
];

const walletFor = (i: number) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
const adminToken = await signIn(new Wallet(env.ADMIN_PRIVATE_KEY!));

for (const p of PERSONAS) {
  const wallet = walletFor(p.account);
  const token = await signIn(wallet);
  const me = await identity("/me", { token });
  if (me.body.role) {
    console.log(`  ✓ ${p.org} already registered`);
    continue;
  }
  let requestId = me.body.latestRequest?.status === "pending" ? me.body.latestRequest.id : null;
  if (!requestId) {
    const req = await identity("/access-requests", {
      token,
      body: { orgName: p.org, contactEmail: p.email, requestedRole: p.role },
    });
    if (req.status !== 201) throw new Error(`${p.org}: ${JSON.stringify(req.body)}`);
    requestId = req.body.id;
  }
  const approved = await identity(`/access-requests/${requestId}/approve`, { token: adminToken, body: {} });
  if (approved.status !== 200) throw new Error(`${p.org}: ${JSON.stringify(approved.body)}`);
  console.log(`  + ${p.org} registered as ${p.role}`);
}

const existing = new Set(((await oracle("/sensors", { token: adminToken })).body as any[]).map((s) => s.sensor_id));
for (const s of SENSORS) {
  if (existing.has(s.sensorId)) continue;
  const res = await oracle("/sensors", { token: adminToken, body: s });
  if (res.status !== 201) throw new Error(`${s.sensorId}: ${JSON.stringify(res.body)}`);
  console.log(`  + sensor ${s.sensorId}`);
}

console.log("\nImport these into MetaMask (Hardhat public test keys — local demo only):\n");
console.log(`  ${"Admin".padEnd(26)} ${new Wallet(env.ADMIN_PRIVATE_KEY!).address}  ${env.ADMIN_PRIVATE_KEY}`);
for (const p of PERSONAS) {
  const w = walletFor(p.account);
  console.log(`  ${p.org.padEnd(26)} ${w.address}  ${w.privateKey}`);
}
process.exit(0);
