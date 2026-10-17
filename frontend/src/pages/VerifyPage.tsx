// Public certificate verification, opened from the QR code on a printed certificate. No sign-in:
// the verdict and the transaction history are read straight from the chain, and the page warns if
// the chain or registry it's reading differs from the one printed on the certificate.
import { ChevronDown, ExternalLink, ShieldCheck, ShieldX } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Logo } from "../components/Layout";
import { Loading, Notice } from "../components/ui";
import { api } from "../lib/api";
import { LEG_NAMES, REASON_LABELS, ROLE_LABELS, type Role, formatTime, shortAddress, shortHash } from "../lib/format";
import { type ChainTx, type OnchainRecord, batchHistory, chainReader, systemWalletLabels, verifyRecord } from "../lib/onchain";

const SEPOLIA = 11155111;

const CERT_LABELS: Record<string, string> = {
  clean: "Clean: every stage passed",
  flagged: "Flagged, awaiting QA rulings",
  resolved: "Flagged, ruled on by QA",
};
const OUTCOME_LABELS: Record<string, string> = {
  upheld: "Upheld: custodian responsible",
  overturned: "Overturned: flag dismissed",
  compensation_agreed: "Compensation agreed (settled off-platform)",
};

/** What each contract call means, in words a buyer or auditor would use. */
const CALL_LABELS: Record<string, string> = {
  createContainer: "Container registered",
  addBatch: "Batch added to container",
  recordSeal: "Seal number recorded",
  initiateTransfer: "Handover started: sender's quality check",
  acceptTransfer: "Handover accepted: receiver's quality check",
  splitContainer: "Container split into batches",
  commitFileHash: "Sensor committed its log fingerprint",
  submitLegSummary: "Oracle checked the uploaded log",
  openClaim: "Flagged stage sent to QA",
  issueLegPass: "Stage verdict issued",
  issueFinalCertificate: "Final certificate issued",
  submitResolution: "QA ruling on a flagged stage",
  submitDisposition: "QA final decision",
  acknowledgeReceipt: "Buyer acknowledged receipt",
};

type Directory = { wallet: string; org_name: string; role: Role; active: boolean }[];

type Loaded = {
  chainId: number;
  registry: string;
  record: OnchainRecord;
  txs: ChainTx[];
  names: Map<string, string>;
};

export function VerifyPage() {
  const { batchId } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const id = Number(batchId);
      if (!Number.isInteger(id) || id <= 0) throw new Error("That isn't a valid batch number.");
      const { config } = await chainReader();
      const record = await verifyRecord(id);
      if (!record) throw new Error(`There is no batch #${id} on this chain.`);
      const [txs, system, directory] = await Promise.all([
        batchHistory(id, record.containerId),
        systemWalletLabels(),
        api<Directory>("identity", "/directory").catch(() => [] as Directory),
      ]);
      const names = new Map(system);
      for (const p of directory) names.set(p.wallet.toLowerCase(), `${p.org_name} (${ROLE_LABELS[p.role] ?? p.role})`);
      setData({ chainId: config.chainId, registry: config.contracts.CertificateRegistry.address, record, txs, names });
    })().catch((err) => setError(err.message ?? String(err)));
  }, [batchId]);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Link to="/">
            <Logo />
          </Link>
          <span className="text-sm text-muted">Certificate verification</span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        {error ? <Notice tone="error">{error}</Notice> : !data ? <Loading /> : <Verified data={data} params={params} />}
      </main>
    </div>
  );
}

function Verified({ data, params }: { data: Loaded; params: URLSearchParams }) {
  const { record: r, txs, names, chainId, registry } = data;
  const who = (w?: string | null) => (w ? (names.get(w.toLowerCase()) ?? "Unregistered wallet") : "—");
  const party = (w?: string | null) => (
    <>
      {who(w)} <span className="font-mono text-xs text-muted">{shortAddress(w)}</span>
    </>
  );

  // The QR link carries the chain and registry the certificate was printed from.
  const expectedChain = params.get("chain");
  const expectedRegistry = params.get("registry");
  const mismatch =
    (expectedChain && Number(expectedChain) !== chainId) || (expectedRegistry && expectedRegistry.toLowerCase() !== registry.toLowerCase());

  const issued = r.certificate;
  const rejected = r.decision?.disposition === "rejected";
  const good = issued && !rejected;

  return (
    <>
      {mismatch && (
        <Notice tone="error">
          This certificate was printed for chain {expectedChain ?? "?"}, registry {shortAddress(expectedRegistry)}. This page is reading chain {chainId},
          registry {shortAddress(registry)}, so the record below may not be the one on the certificate.
        </Notice>
      )}

      <section
        data-testid="verify-verdict"
        className={`flex items-start gap-4 rounded-xl border-2 px-5 py-4 ${
          !issued ? "border-line bg-white" : good ? "border-pass bg-pass-soft" : "border-fail bg-fail-soft"
        }`}
      >
        {good ? <ShieldCheck className="size-9 shrink-0 text-pass" aria-hidden /> : <ShieldX className={`size-9 shrink-0 ${issued ? "text-fail" : "text-muted"}`} aria-hidden />}
        <div>
          <h1 className="text-xl font-semibold">
            {!issued ? `Batch #${r.batchId}: certificate not issued yet` : `Batch #${r.batchId}: certificate found on-chain`}
          </h1>
          {issued && (
            <p className="mt-1">
              <strong>{CERT_LABELS[issued.status]}</strong> · issued {formatTime(issued.issuedAt)} · QA decision:{" "}
              <strong>{!r.decision ? "pending" : r.decision.disposition === "released" ? "released for sale" : "rejected, not to be sold"}</strong>
            </p>
          )}
          <p className="mt-1 text-sm text-muted">
            Read directly from chain {chainId}, CertificateRegistry <span className="font-mono">{shortAddress(registry)}</span>. Compare these figures with
            the printed certificate: any difference means the paper copy was altered.
          </p>
        </div>
      </section>

      <Card title="Batch">
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          <Item label="Batch / container">
            Batch #{r.batchId} · Container <span className="font-mono">{r.containerCode}</span>
          </Item>
          <Item label="Origin seal">
            {r.sealNumber ? (
              <>
                <span className="font-mono">{r.sealNumber}</span> <span className="text-sm text-muted">recorded by the supplier before dispatch</span>
              </>
            ) : (
              "—"
            )}
          </Item>
          <Item label="Temperature rule">
            ≤ {r.thresholdC} °C, {r.graceMinutes} min grace period
          </Item>
          <Item label="Supplier">{party(r.supplier)}</Item>
          <Item label="Buyer">{party(r.buyer)}</Item>
          <Item label="Quality Inspector">{party(r.inspector)}</Item>
          <Item label="Buyer's acknowledgement">
            {r.acknowledgement ? `${who(r.acknowledgement.buyer)}, ${formatTime(r.acknowledgement.acknowledgedAt)}` : "Not yet acknowledged"}
          </Item>
        </dl>
      </Card>

      <Card title="Stage verdicts">
        <ul className="divide-y divide-line">
          {r.stages.map((s) => (
            <li key={s.stage} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <div>
                <span className="font-medium">
                  {s.stage}. {LEG_NAMES[s.stage]}
                </span>
                <div className="text-sm text-muted">{s.custodian ? party(s.custodian) : "No verdict yet"}</div>
              </div>
              <div className="text-right">
                {s.status === "pass" ? (
                  <span className="font-semibold text-pass">PASS</span>
                ) : s.status === "flagged" ? (
                  <>
                    <span className="font-semibold text-fail">FLAGGED</span>
                    <div className="text-xs text-fail">{s.reasons.map((x) => REASON_LABELS[x]).join("; ")}</div>
                  </>
                ) : (
                  <span className="text-muted">Pending</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {(r.claims.length > 0 || r.decision) && (
        <Card title="QA">
          <ul className="space-y-2">
            {r.claims.map((c) => (
              <li key={c.id}>
                <span className="font-medium">
                  Stage {c.leg} ({LEG_NAMES[c.leg]}):
                </span>{" "}
                {c.outcome ? OUTCOME_LABELS[c.outcome] : <span className="text-warn">awaiting ruling</span>}
                {c.outcome && (
                  <div className="text-sm text-muted">
                    “{c.note}” · {who(c.inspector)}
                  </div>
                )}
              </li>
            ))}
            {r.decision && (
              <li>
                <span className="font-medium">Final decision:</span> {r.decision.disposition === "released" ? "Released for sale" : "Rejected"} by{" "}
                {who(r.decision.inspector)}, {formatTime(r.decision.decidedAt)}
                <div className="text-sm text-muted">“{r.decision.note}”</div>
              </li>
            )}
          </ul>
        </Card>
      )}

      <Card title={`Transaction history (${txs.length})`}>
        <p className="mb-3 text-sm text-muted">
          Every transaction that touched this batch, its container or its QA claims, in block order. Each one was signed by the wallet shown.
        </p>
        <ol data-testid="tx-history" className="space-y-2">
          {txs.map((tx) => (
            <TxRow key={tx.hash} tx={tx} who={who} chainId={chainId} />
          ))}
        </ol>
      </Card>

      <p className="text-center text-xs text-muted">
        ColdChainSG records evidence only: it does not hold or move money. Raw sensor readings stay off-chain; only their SHA-256 fingerprints are
        recorded.
      </p>
    </>
  );
}

function TxRow({ tx, who, chainId }: { tx: ChainTx; who: (w: string) => string; chainId: number }) {
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState<{ status: number | null; gasUsed: bigint } | null>(null);

  useEffect(() => {
    if (!open || receipt) return;
    chainReader()
      .then(({ provider }) => provider.getTransactionReceipt(tx.hash))
      .then((rc) => rc && setReceipt({ status: rc.status, gasUsed: rc.gasUsed }));
  }, [open, receipt, tx.hash]);

  return (
    <li className="rounded-lg border border-line bg-white">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left" aria-expanded={open}>
        <div>
          <div className="font-medium">{CALL_LABELS[tx.fn] ?? tx.fn}</div>
          <div className="text-xs text-muted">
            {formatTime(tx.timestamp)} · block {tx.blockNumber} · {who(tx.from)}
          </div>
        </div>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line px-3 py-2 font-mono text-[11px]">
          <dt className="text-muted">Tx hash</dt>
          <dd className="break-all">
            {chainId === SEPOLIA ? (
              <a href={`https://sepolia.etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                {tx.hash} <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              tx.hash
            )}
          </dd>
          <dt className="text-muted">Signed by</dt>
          <dd className="break-all">{tx.from}</dd>
          <dt className="text-muted">Call</dt>
          <dd className="break-all">
            {tx.contract}.{tx.fn}({tx.fnArgs.map(([k, v]) => `${k}=${show(v)}`).join(", ")})
          </dd>
          <dt className="text-muted">Events</dt>
          <dd>
            {tx.events.map((e, i) => (
              <div key={i} className="break-all">
                {e.name}({Object.entries(e.args).map(([k, v]) => `${k}=${show(v)}`).join(", ")})
              </div>
            ))}
          </dd>
          <dt className="text-muted">Receipt</dt>
          <dd>{receipt ? `${receipt.status === 1 ? "success" : "failed"} · gas ${receipt.gasUsed}` : "loading…"}</dd>
        </dl>
      )}
    </li>
  );
}

/** Compact display of decoded values: long hex strings shortened, structs as [a, b, …]. */
function show(v: unknown): string {
  if (typeof v === "string") return /^0x[0-9a-fA-F]{40,}$/.test(v) ? (v.length === 42 ? shortAddress(v) : shortHash(v)) : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  return String(v);
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-white px-5 py-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
