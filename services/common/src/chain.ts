import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Contract, JsonRpcProvider, NonceManager, type TransactionRequest, Wallet, ZeroHash, id } from "ethers";
import { env, repoRoot } from "./env.ts";

// cacheTimeout -1: ethers otherwise caches identical requests for 250ms, which returns stale
// nonces when the local chain mines instantly.
export const provider = new JsonRpcProvider(env.RPC_URL, undefined, { cacheTimeout: -1 });

type Deployment = {
  chainId: number;
  contracts: Record<string, { address: string; abi: any[] }>;
};

let deployment: Deployment | undefined;

/** Reads deployments/<network>.json, written by `npm run deploy`. */
export function getDeployment(): Deployment {
  if (!deployment) {
    const file = join(repoRoot, "deployments", `${env.CHAIN_NETWORK}.json`);
    try {
      deployment = JSON.parse(readFileSync(file, "utf8")) as Deployment;
    } catch {
      throw new Error(`No deployment found at ${file}. Start the chain and run \`npm run deploy\` first.`);
    }
  }
  return deployment;
}

/**
 * Sends one transaction at a time and reads the nonce fresh from the chain before each one.
 * A cached nonce would go stale here: the admin key is used by more than one service
 * (identity and oracle), and a rejected transaction must not leave a gap.
 */
export class TxSigner extends NonceManager {
  #queue: Promise<unknown> = Promise.resolve();

  override sendTransaction(tx: TransactionRequest) {
    const send = this.#queue.then(() => {
      this.reset();
      return super.sendTransaction(tx);
    });
    this.#queue = send.catch(() => undefined);
    return send;
  }
}

const signers = new Map<string, TxSigner>();

/** A wallet that sends transactions on behalf of a service. */
export function serviceSigner(privateKey: string | undefined, label: string) {
  if (!privateKey) throw new Error(`${label} private key is not set in .env`);
  let signer = signers.get(privateKey);
  if (!signer) {
    signer = new TxSigner(new Wallet(privateKey, provider));
    signers.set(privateKey, signer);
  }
  return signer;
}

/** A contract instance. Read-only unless a signer is passed. */
export function contract(name: string, signer?: TxSigner): Contract {
  const entry = getDeployment().contracts[name];
  if (!entry) throw new Error(`${name} is not in the deployment file`);
  return new Contract(entry.address, entry.abi, signer ?? provider);
}

/**
 * Finds `eventName` emitted by `contractName` in a mined transaction, or returns null.
 * Used to verify a transaction the user sent from MetaMask before trusting metadata about it.
 */
export async function findEvent(contractName: string, txHash: string, eventName: string) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return null;
  const c = contract(contractName);
  const address = (await c.getAddress()).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address) continue;
    const parsed = c.interface.parseLog(log);
    if (parsed?.name === eventName) return parsed.args;
  }
  return null;
}

// ---- Roles ----------------------------------------------------------------

export const PARTICIPANT_ROLES = [
  "SUPPLIER",
  "CARRIER",
  "HANDLER",
  "COLD_STORE",
  "TRUCK",
  "BUYER",
  "INSPECTOR",
] as const;
export const SERVICE_ROLES = ["ORACLE", "CERTIFIER"] as const;

export type Role = (typeof PARTICIPANT_ROLES)[number] | (typeof SERVICE_ROLES)[number] | "ADMIN";

const roleByHash = new Map<string, Role>(
  [...PARTICIPANT_ROLES, ...SERVICE_ROLES].map((name) => [id(name), name]),
);

export const roleHash = (role: Role) => id(role);
export const roleName = (hash: string): Role | null => roleByHash.get(hash) ?? null;

/** Live on-chain role lookup. Returns null for unknown or suspended wallets. */
export async function lookupRole(address: string): Promise<Role | null> {
  const registry = contract("ParticipantRegistry");
  if (await registry.hasRole(ZeroHash, address)) return "ADMIN"; // DEFAULT_ADMIN_ROLE is 0x00
  const hash: string = await registry.roleOf(address);
  return roleByHash.get(hash) ?? null;
}
