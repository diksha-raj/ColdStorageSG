// Helpers for the end-to-end service tests. They need the local chain, a deployment,
// and the identity service running. Each test creates fresh wallets so runs don't collide.
import { type BaseWallet, Contract, type Provider, Wallet, encodeBytes32String, parseEther } from "ethers";
import { SiweMessage } from "siwe";
import { TxSigner, getDeployment, provider, roleHash, type Role } from "./chain.ts";

export { provider };
import { env } from "./env.ts";

const IDENTITY = `http://localhost:${env.IDENTITY_PORT}`;

const admin = new TxSigner(new Wallet(env.ADMIN_PRIVATE_KEY!, provider));

export function api(baseUrl: string) {
  return async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const res = await fetch(baseUrl + path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
}

export async function signIn(wallet: BaseWallet): Promise<string> {
  const call = api(IDENTITY);
  const { body: n } = await call("/auth/nonce");
  const message = new SiweMessage({
    domain: n.domain,
    address: wallet.address,
    uri: `http://${n.domain}`,
    version: "1",
    chainId: n.chainId,
    nonce: n.nonce,
  }).prepareMessage();
  const { status, body } = await call("/auth/verify", {
    body: { message, signature: await wallet.signMessage(message) },
  });
  if (status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(body)}`);
  return body.token;
}

export function deployed(name: string, runner: BaseWallet | TxSigner | Provider) {
  const { address, abi } = getDeployment().contracts[name];
  return new Contract(address, abi, runner);
}

/** A fresh wallet with gas money, registered on-chain with `role`, and signed in. */
export async function persona(role: Exclude<Role, "ADMIN" | "ORACLE" | "CERTIFIER">) {
  const wallet = Wallet.createRandom(provider);
  await (await admin.sendTransaction({ to: wallet.address, value: parseEther("1") })).wait();
  const registry = deployed("ParticipantRegistry", admin);
  await (await registry.registerParticipant(wallet.address, roleHash(role))).wait();
  return { wallet, signer: new TxSigner(wallet), address: wallet.address, token: await signIn(wallet) };
}

export const adminToken = () => signIn(new Wallet(env.ADMIN_PRIVATE_KEY!));

/** createContainer's container-number argument when the contract should generate one. */
export const AUTO_NUMBER = "0x" + "00".repeat(11);

/** The seal number the supplier records before dispatch (required by initiateTransfer at origin). */
export const SEAL = encodeBytes32String("SGB4471203");

/** A passing handover quality check: 3.0 °C, nothing unrefrigerated, sealed, no issues. */
export const OK_CHECK = {
  tempTenthsC: 30,
  unrefrigeratedMinutes: 0,
  damaged: false,
  sealIntact: true,
  issues: false,
  notesHash: "0x" + "0".repeat(64),
};
