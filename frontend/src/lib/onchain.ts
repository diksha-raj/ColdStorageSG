// Read-only access to the chain for the public verification page. Everything here is read
// straight from the chain node, not from the ColdChainSG services, so a verifier doesn't have to
// trust our backend for the record itself. (Contract addresses and ABIs still come from the
// deployment the identity service serves; the QR link carries the expected chain and registry
// address so a mismatch shows up on the page.)
import { Contract, JsonRpcProvider, type Result, ZeroHash, decodeBytes32String, id, toUtf8String } from "ethers";
import { getConfig } from "./chain";

type Reader = Awaited<ReturnType<typeof makeReader>>;

async function makeReader() {
  const config = await getConfig();
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  const contract = (name: string) => new Contract(config.contracts[name].address, config.contracts[name].abi, provider);
  return {
    config,
    provider,
    registry: contract("ParticipantRegistry"),
    custody: contract("ShipmentCustody"),
    sensors: contract("SensorOracle"),
    certs: contract("CertificateRegistry"),
  };
}

let readerPromise: Promise<Reader> | null = null;
export const chainReader = () => (readerPromise ??= makeReader());

const CERT_STATUS = ["none", "clean", "flagged", "resolved"] as const;
const DISPOSITION = ["none", "released", "rejected"] as const;
const OUTCOME = ["upheld", "overturned", "compensation_agreed"] as const;
const FLAG_REASONS: [number, string][] = [
  [1, "sensor_excursion"],
  [2, "receipt_temp"],
  [4, "unrefrigerated"],
  [8, "condition"],
];

export type OnchainRecord = {
  batchId: number;
  containerId: number;
  containerCode: string;
  sealNumber: string | null;
  supplier: string;
  buyer: string;
  inspector: string;
  thresholdC: number;
  graceMinutes: number;
  certificate: { status: (typeof CERT_STATUS)[number]; issuedAt: number } | null;
  stages: { stage: number; custodian: string | null; status: "pass" | "flagged" | "pending"; reasons: string[] }[];
  claims: { id: number; leg: number; custodian: string; outcome: (typeof OUTCOME)[number] | null; note: string; inspector: string | null }[];
  decision: { disposition: "released" | "rejected"; inspector: string; note: string; decidedAt: number } | null;
  acknowledgement: { buyer: string; acknowledgedAt: number } | null;
};

/** The batch's certificate, stage verdicts, QA rulings, decision and receipt, as the contracts hold them. */
export async function verifyRecord(batchId: number): Promise<OnchainRecord | null> {
  const { custody, certs } = await chainReader();
  const unit = await custody.getUnit(batchId);
  if (Number(unit.kind) !== 2) return null; // no batch with this id on this chain

  const container = await custody.getUnit(unit.containerId);
  const cert = await certs.getCertificate(batchId);
  const stages = await Promise.all(
    [0, 1, 2, 3, 4].map(async (stage) => {
      const passId = Number(await certs.legPassOf(batchId, stage));
      if (!passId) return { stage, custodian: null, status: "pending" as const, reasons: [] };
      const lp = await certs.getLegPass(passId);
      return {
        stage,
        custodian: lp.custodian as string,
        status: Number(lp.status) === 0 ? ("pass" as const) : ("flagged" as const),
        reasons: FLAG_REASONS.filter(([bit]) => Number(lp.flags) & bit).map(([, r]) => r),
      };
    }),
  );
  const claimIds = ((await certs.getClaimsOfBatch(batchId)) as bigint[]).map(Number);
  const claims = await Promise.all(
    claimIds.map(async (claimId) => {
      const c = await certs.getClaim(claimId);
      const r: Result | null = Number(c.resolutionId) ? await certs.getResolution(c.resolutionId) : null;
      return {
        id: claimId,
        leg: Number(c.leg),
        custodian: c.provisionalCustodian as string,
        outcome: r ? OUTCOME[Number(r.outcome)] : null,
        note: r ? (r.note as string) : "",
        inspector: r ? (r.inspector as string) : null,
      };
    }),
  );
  const d = await certs.getDecision(batchId);
  const ack = await certs.acknowledgements(batchId);

  return {
    batchId,
    containerId: Number(unit.containerId),
    containerCode: toUtf8String(unit.code),
    sealNumber: container.sealNumber === ZeroHash ? null : decodeBytes32String(container.sealNumber),
    supplier: unit.supplier,
    buyer: unit.buyer,
    inspector: unit.inspector,
    thresholdC: Number(unit.thresholdTenthsC) / 10,
    graceMinutes: Number(unit.graceMinutes),
    certificate: Number(cert.status) ? { status: CERT_STATUS[Number(cert.status)], issuedAt: Number(cert.issuedAt) } : null,
    stages,
    claims: claims.sort((a, b) => a.leg - b.leg),
    decision: Number(d.disposition)
      ? {
          disposition: DISPOSITION[Number(d.disposition)] as "released" | "rejected",
          inspector: d.inspector,
          note: d.note,
          decidedAt: Number(d.decidedAt),
        }
      : null,
    acknowledgement: Number(ack.acknowledgedAt) ? { buyer: ack.buyer, acknowledgedAt: Number(ack.acknowledgedAt) } : null,
  };
}

export type ChainEvent = { contract: string; name: string; args: Record<string, unknown> };
export type ChainTx = {
  hash: string;
  blockNumber: number;
  timestamp: number;
  from: string;
  contract: string;
  fn: string;
  fnArgs: [string, unknown][];
  events: ChainEvent[];
};

/** bigint → number and ethers Results → plain arrays, so the values can be shown and compared. */
const plain = (v: unknown): unknown => (typeof v === "bigint" ? Number(v) : Array.isArray(v) ? [...v].map(plain) : v);
const named = (inputs: readonly { name: string }[], values: Result) => inputs.map((input, i) => [input.name, plain(values[i])] as [string, unknown]);

const HISTORY_CONTRACTS = ["ShipmentCustody", "SensorOracle", "CertificateRegistry"] as const;

/** Every transaction that touched this batch, its container or its claims, oldest first. */
export async function batchHistory(batchId: number, containerId: number): Promise<ChainTx[]> {
  const r = await chainReader();
  const claimIds = new Set(((await r.certs.getClaimsOfBatch(batchId)) as bigint[]).map(Number));
  const units = new Set([batchId, containerId]);

  // An event belongs to the batch if it names the batch, one of its claims, or (custody and sensor
  // events) its container, which carried the batch through stages 1-2.
  const belongs = (a: Record<string, unknown>) => {
    if (a.batchId !== undefined) return a.batchId === batchId;
    if (a.claimId !== undefined) return claimIds.has(a.claimId as number);
    for (const key of ["id", "containerId", "shipmentId"]) if (a[key] !== undefined) return units.has(a[key] as number);
    return false;
  };

  const byName: Record<string, Contract> = { ShipmentCustody: r.custody, SensorOracle: r.sensors, CertificateRegistry: r.certs };
  const groups = new Map<string, { blockNumber: number; events: ChainEvent[] }>();
  for (const name of HISTORY_CONTRACTS) {
    const c = byName[name];
    const logs = await r.provider.getLogs({ address: await c.getAddress(), fromBlock: 0, toBlock: "latest" });
    for (const log of logs) {
      const parsed = c.interface.parseLog(log);
      if (!parsed) continue;
      const args = Object.fromEntries(named(parsed.fragment.inputs, parsed.args));
      if (!belongs(args)) continue;
      const g = groups.get(log.transactionHash) ?? { blockNumber: log.blockNumber, events: [] };
      g.events.push({ contract: name, name: parsed.name, args });
      groups.set(log.transactionHash, g);
    }
  }

  const contractAt = new Map(Object.entries(r.config.contracts).map(([n, c]) => [c.address.toLowerCase(), n]));
  const blockTimes = new Map<number, number>();
  const txs = await Promise.all(
    [...groups].map(async ([hash, g]): Promise<ChainTx> => {
      const tx = (await r.provider.getTransaction(hash))!;
      if (!blockTimes.has(g.blockNumber)) blockTimes.set(g.blockNumber, (await r.provider.getBlock(g.blockNumber))!.timestamp);
      const contract = contractAt.get((tx.to ?? "").toLowerCase()) ?? "Unknown contract";
      const call = byName[contract]?.interface.parseTransaction({ data: tx.data, value: tx.value });
      return {
        hash,
        blockNumber: g.blockNumber,
        timestamp: blockTimes.get(g.blockNumber)!,
        from: tx.from,
        contract,
        fn: call?.name ?? "unknown",
        fnArgs: call ? named(call.fragment.inputs, call.args) : [],
        events: g.events,
      };
    }),
  );
  return txs.sort((a, b) => a.blockNumber - b.blockNumber);
}

/** The transaction that issued the batch's final certificate, if any. */
export async function issuingTx(batchId: number): Promise<{ hash: string; blockNumber: number } | null> {
  const { provider, certs } = await chainReader();
  const logs = await provider.getLogs({
    address: await certs.getAddress(),
    topics: [certs.interface.getEvent("FinalCertificateIssued")!.topicHash, "0x" + batchId.toString(16).padStart(64, "0")],
    fromBlock: 0,
    toBlock: "latest",
  });
  return logs[0] ? { hash: logs[0].transactionHash, blockNumber: logs[0].blockNumber } : null;
}

/** Labels for the wallets that aren't organisations: the admin, the service wallets and sensor devices. */
export async function systemWalletLabels(): Promise<Map<string, string>> {
  const { provider, registry, sensors } = await chainReader();
  const labels = new Map<string, string>();
  for (const log of await provider.getLogs({ address: await registry.getAddress(), fromBlock: 0, toBlock: "latest" })) {
    const parsed = registry.interface.parseLog(log);
    if (parsed?.name === "RoleGranted" && parsed.args.role === ZeroHash) labels.set(parsed.args.account.toLowerCase(), "Platform admin");
    if (parsed?.name === "ParticipantRegistered" && parsed.args.role === id("ORACLE")) labels.set(parsed.args.wallet.toLowerCase(), "Oracle service");
    if (parsed?.name === "ParticipantRegistered" && parsed.args.role === id("CERTIFIER"))
      labels.set(parsed.args.wallet.toLowerCase(), "Certificate service");
  }
  for (const log of await provider.getLogs({ address: await sensors.getAddress(), fromBlock: 0, toBlock: "latest" })) {
    const parsed = sensors.interface.parseLog(log);
    if (parsed?.name === "SensorRegistered") labels.set(parsed.args.device.toLowerCase(), "Sensor device");
  }
  return labels;
}
