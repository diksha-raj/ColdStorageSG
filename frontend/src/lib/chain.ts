// MetaMask + contract helpers. Users sign their own custody, resolution and acknowledgement
// transactions here, so the on-chain record shows the real wallet that acted.
import { BrowserProvider, Contract, type Eip1193Provider, JsonRpcProvider, type LogDescription, getAddress } from "ethers";
import { SiweMessage } from "siwe";
import { ApiError, api } from "./api";

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      on?: (event: string, handler: (...args: any[]) => void) => void;
      removeListener?: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
}

type Config = { chainId: number; rpcUrl: string; contracts: Record<string, { address: string; abi: any[] }> };

let configPromise: Promise<Config> | null = null;
export const getConfig = () => (configPromise ??= api<Config>("identity", "/config"));

export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;

function ethereum() {
  if (!window.ethereum) throw new Error("MetaMask not found. Install it to continue.");
  return window.ethereum;
}

/** Makes sure MetaMask is on the ColdChainSG chain, adding it if needed. */
async function ensureChain({ chainId, rpcUrl }: Config) {
  const hex = "0x" + chainId.toString(16);
  try {
    await ethereum().request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err: any) {
    if (err?.code !== 4902) throw err; // 4902 = chain not added yet
    await ethereum().request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chainId === 31337 ? "ColdChainSG Local (Hardhat)" : `Chain ${chainId}`,
          rpcUrls: [rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        },
      ],
    });
  }
}

export async function connectWallet(): Promise<string> {
  const config = await getConfig();
  const [account] = (await ethereum().request({ method: "eth_requestAccounts" })) as string[];
  await ensureChain(config);
  return getAddress(account);
}

/** Sign-In with Ethereum: sign a one-time message; the Identity Service verifies it. */
export async function signInWithEthereum(address: string) {
  const { nonce, chainId, domain } = await api("identity", "/auth/nonce");
  const message = new SiweMessage({
    domain,
    address,
    statement: "Sign in to ColdChainSG. This does not send a transaction or cost gas.",
    uri: window.location.origin,
    version: "1",
    chainId,
    nonce,
  }).prepareMessage();
  const signer = await new BrowserProvider(ethereum()).getSigner(address);
  const signature = await signer.signMessage(message);
  return api<{ token: string; wallet: string; role: string | null }>("identity", "/auth/verify", {
    body: { message, signature },
  });
}

export type TxResult = { hash: string; events: LogDescription[] };

/** Sends a transaction from the connected wallet and waits for it to be mined. */
export async function sendTx(contractName: string, method: string, args: unknown[]): Promise<TxResult> {
  const config = await getConfig();
  await ensureChain(config);
  const { address, abi } = config.contracts[contractName];
  const signer = await new BrowserProvider(ethereum()).getSigner();
  const contract = new Contract(address, abi, signer);

  const tx = await contract[method](...args);
  const receipt = await tx.wait();
  const events = receipt.logs
    .filter((log: any) => log.address.toLowerCase() === address.toLowerCase())
    .map((log: any) => contract.interface.parseLog(log))
    .filter(Boolean);
  return { hash: tx.hash, events };
}

/** Read-only contract access through the chain's RPC (no wallet needed). */
export async function readContract(contractName: string) {
  const config = await getConfig();
  const { address, abi } = config.contracts[contractName];
  return new Contract(address, abi, new JsonRpcProvider(config.rpcUrl));
}

/** Human-readable message for wallet, contract and API errors. */
export function friendlyError(err: unknown): string {
  const e = err as any;
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "You cancelled the request in MetaMask.";
  if (e instanceof ApiError) return e.message;
  if (e?.reason) return `Rejected by contract: ${e.reason}`;
  if (e?.shortMessage) return e.shortMessage;
  return e?.message ?? "Something went wrong.";
}

/** SHA-256 of bytes using the browser's built-in Web Crypto, as a 0x-prefixed hex string. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
