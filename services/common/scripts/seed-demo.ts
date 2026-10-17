// Onboards the demo organisations through the real flow (sign in → request access → admin
// approves on-chain). Safe to re-run: organisations already registered are skipped. Sensors aren't
// seeded: each party registers its own when it takes a shipment.
//
//   npm run seed      (needs the chain, a deployment, and the identity service running)
//
// Wallets are Hardhat's PUBLIC test accounts #4-#12 — fine for a local demo, never for real funds.
import { HDNodeWallet, Wallet } from "ethers";
import { env } from "../src/index.ts";
import { api, signIn } from "../src/testing.ts";

const MNEMONIC = "test test test test test test test test test test test junk"; // Hardhat default
const identity = api(`http://localhost:${env.IDENTITY_PORT}`);

const PERSONAS = [
  { account: 4, role: "SUPPLIER", org: "Merlion Fresh Supplies", email: "ops@merlionfresh.example" },
  { account: 5, role: "CARRIER", org: "Equator Air Cargo", email: "ops@equatorair.example" },
  { account: 6, role: "HANDLER", org: "Runway Cargo Handlers", email: "ops@runwaycargo.example" },
  { account: 7, role: "COLD_STORE", org: "Merlion Fresh Cold Store", email: "coldstore@merlionfresh.example" },
  { account: 8, role: "TRUCK", org: "Kallang Reefer Trucks", email: "dispatch@kallangreefer.example" },
  { account: 9, role: "BUYER", org: "Tiong Bahru Grocers", email: "orders@tbgrocers.example" },
  { account: 10, role: "INSPECTOR", org: "Tiong Bahru Grocers QA", email: "qa@tbgrocers.example" },
  { account: 11, role: "BUYER", org: "Marina Bay Dining Group", email: "orders@mbdining.example" },
  { account: 12, role: "INSPECTOR", org: "Marina Bay Dining QA", email: "qa@mbdining.example" },
] as const;


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

console.log("\nImport these into MetaMask (Hardhat public test keys — local demo only):\n");
console.log(`  ${"Admin".padEnd(26)} ${new Wallet(env.ADMIN_PRIVATE_KEY!).address}  ${env.ADMIN_PRIVATE_KEY}`);
for (const p of PERSONAS) {
  const w = walletFor(p.account);
  console.log(`  ${p.org.padEnd(26)} ${w.address}  ${w.privateKey}`);
}
process.exit(0);
