// End-to-end: needs `npm run chain`, `npm run deploy`, and the identity service running.
// Uses fresh random wallets so it can be re-run against the same chain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseWallet, Wallet } from "ethers";
import { SiweMessage } from "siwe";

const API = process.env.IDENTITY_URL ?? `http://localhost:${process.env.IDENTITY_PORT ?? 4001}`;
const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Hardhat #0

async function call(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(API + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function signIn(wallet: BaseWallet, overrides: Partial<{ domain: string; nonce: string }> = {}) {
  const { body: n } = await call("/auth/nonce");
  const message = new SiweMessage({
    domain: overrides.domain ?? n.domain,
    address: wallet.address,
    statement: "Sign in to ColdChainSG",
    uri: `http://${n.domain}`,
    version: "1",
    chainId: n.chainId,
    nonce: overrides.nonce ?? n.nonce,
  }).prepareMessage();
  const signature = await wallet.signMessage(message);
  return { ...(await call("/auth/verify", { body: { message, signature } })), message, signature };
}

test("admin wallet signs in with role ADMIN", async () => {
  const { status, body } = await signIn(new Wallet(ADMIN_KEY));
  assert.equal(status, 200);
  assert.equal(body.role, "ADMIN");
});

test("unknown wallet → request access → admin approves → role is live on-chain", async () => {
  const newcomer = Wallet.createRandom();
  const login = await signIn(newcomer);
  assert.equal(login.status, 200);
  assert.equal(login.body.role, null, "unknown wallet has no role yet");

  const request = await call("/access-requests", {
    token: login.body.token,
    body: { orgName: "Test Buyer Pte Ltd", contactEmail: "qa@testbuyer.sg", requestedRole: "BUYER" },
  });
  assert.equal(request.status, 201);

  const duplicate = await call("/access-requests", {
    token: login.body.token,
    body: { orgName: "Again", contactEmail: "qa@testbuyer.sg", requestedRole: "BUYER" },
  });
  assert.equal(duplicate.status, 409, "only one pending request per wallet");

  // Non-admins cannot see or approve requests.
  assert.equal((await call("/access-requests", { token: login.body.token })).status, 403);

  const admin = await signIn(new Wallet(ADMIN_KEY));
  const pending = await call("/access-requests", { token: admin.body.token });
  assert.ok(pending.body.some((r: any) => r.id === request.body.id));

  const approved = await call(`/access-requests/${request.body.id}/approve`, { token: admin.body.token, body: {} });
  assert.equal(approved.status, 200);
  assert.match(approved.body.txHash, /^0x[0-9a-f]{64}$/);

  // Same session token, role now resolved live from ParticipantRegistry.
  const me = await call("/me", { token: login.body.token });
  assert.equal(me.body.role, "BUYER");
  assert.equal(me.body.profile.org_name, "Test Buyer Pte Ltd");

  const buyers = await call("/participants?role=BUYER", { token: login.body.token });
  assert.ok(buyers.body.some((p: any) => p.wallet === newcomer.address));

  // Suspension takes effect immediately.
  const suspended = await call(`/participants/${newcomer.address}/suspend`, { token: admin.body.token, body: {} });
  assert.equal(suspended.status, 200);
  assert.equal((await call("/me", { token: login.body.token })).body.role, null);
});

test("rejects replayed nonce, wrong domain, bad signature, and missing token", async () => {
  const wallet = Wallet.createRandom();
  const first = await signIn(wallet);
  assert.equal(first.status, 200);

  const replay = await call("/auth/verify", { body: { message: first.message, signature: first.signature } });
  assert.equal(replay.status, 401, "nonce cannot be reused");

  const wrongDomain = await signIn(wallet, { domain: "evil.example" });
  assert.equal(wrongDomain.status, 401);

  const { body: n } = await call("/auth/nonce");
  const message = new SiweMessage({
    domain: n.domain,
    address: wallet.address,
    uri: `http://${n.domain}`,
    version: "1",
    chainId: n.chainId,
    nonce: n.nonce,
  }).prepareMessage();
  const forged = await call("/auth/verify", {
    body: { message, signature: await Wallet.createRandom().signMessage(message) },
  });
  assert.equal(forged.status, 401, "signature from a different wallet");

  assert.equal((await call("/me")).status, 401);
  assert.equal((await call("/me", { token: "not-a-jwt" })).status, 401);
});

test("validates input", async () => {
  const login = await signIn(Wallet.createRandom());
  const bad = await call("/access-requests", {
    token: login.body.token,
    body: { orgName: "X", contactEmail: "not-an-email", requestedRole: "ADMIN" },
  });
  assert.equal(bad.status, 400);
});

test("the public directory needs no sign-in and never exposes contact details", async () => {
  const { status, body } = await call("/directory");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  for (const row of body) assert.deepEqual(Object.keys(row).sort(), ["active", "org_name", "role", "wallet"]);
  assert.ok(!JSON.stringify(body).includes("@"), "no email addresses");
});
