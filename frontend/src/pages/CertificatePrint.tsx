// A printable, A4 quality certificate for one batch, built live from the on-chain record.
// "Print / Save as PDF" uses the browser's print dialog. Only available once the certificate is issued.
import { ArrowLeft, Printer, Snowflake } from "lucide-react";
import QRCode from "qrcode";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Loading, Notice } from "../components/ui";
import { getConfig } from "../lib/chain";
import { issuingTx } from "../lib/onchain";
import { HANDOVER_NAMES, LEG_NAMES, REASON_LABELS, shortAddress } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useParticipants } from "../lib/participants";
import type { BatchCertificate, Evidence, ShipmentDetail } from "../lib/types";

const OUTCOME_LABELS: Record<string, string> = {
  upheld: "Upheld: custodian responsible",
  overturned: "Overturned: flag dismissed",
  compensation_agreed: "Compensation agreed (settled off-platform)",
};

const STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  clean: { label: "CLEAN: every stage passed", tone: "border-pass text-pass bg-pass-soft" },
  resolved: { label: "FLAGGED, RULED ON BY QA", tone: "border-warn text-warn bg-warn-soft" },
  flagged: { label: "FLAGGED, AWAITING QA RULINGS", tone: "border-warn text-warn bg-warn-soft" },
};

const fullTime = (unix?: number | null) =>
  unix
    ? new Date(unix * 1000).toLocaleString("en-SG", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

export function CertificatePrint() {
  const { batchId } = useParams();
  const { data: s, error } = useApi<ShipmentDetail>("custody", `/shipments/${batchId}`);
  const { data: cert } = useApi<BatchCertificate>("certificate", `/certificates/${batchId}`);
  const { data: evidence } = useApi<Evidence>("oracle", `/evidence/${batchId}`);
  const { get } = useParticipants();
  const [chain, setChain] = useState<{ chainId: number; registry: string } | null>(null);
  const [issuance, setIssuance] = useState<{ hash: string; blockNumber: number } | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    getConfig().then((c) => setChain({ chainId: c.chainId, registry: c.contracts.CertificateRegistry.address }));
    issuingTx(Number(batchId)).then(setIssuance);
  }, [batchId]);

  // The QR opens the public verification page, pinned to the chain and registry this was printed from.
  const verifyUrl = chain ? `${window.location.origin}/verify/${batchId}?chain=${chain.chainId}&registry=${chain.registry}` : null;
  useEffect(() => {
    if (verifyUrl) QRCode.toDataURL(verifyUrl, { margin: 1, width: 240 }).then(setQr);
  }, [verifyUrl]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!s || !cert || !evidence || !chain) return <Loading />;
  if (s.kind !== "batch") return <Notice tone="error">Certificates are issued per batch.</Notice>;
  if (!cert.certificate) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Notice tone="info">
          This batch's certificate hasn't been issued yet. It's issued once all five stages have their handover check and legs 1-4 have a
          verified sensor log.
        </Notice>
        <Link to={`/shipments/${batchId}`} className="mt-4 inline-block text-sm text-brand-dark underline">
          Back to the batch
        </Link>
      </div>
    );
  }

  const org = (w?: string | null) => (w ? (get(w)?.org_name ?? shortAddress(w)) : "—");
  const number = `CCSG-${chain.chainId}-${String(cert.batchId).padStart(5, "0")}`;
  const status = STATUS_TEXT[cert.certificate.status];
  const decision = cert.decision;

  // The origin seal stays on the container until the cold store opens it to split (stages 0-2).
  const sealChecks = s.checkpoints.filter((c) => c.stage <= 2 && c.incoming);
  const sealBroken = sealChecks.filter((c) => !c.incoming!.sealIntact).map((c) => c.stage);
  const sealSummary = sealBroken.length
    ? `reported broken on receipt at stage ${sealBroken.join(", ")}`
    : `reported intact at ${sealChecks.length} container handover(s), then opened at the cold store for the split`;

  const rows = [0, 1, 2, 3, 4].map((stage) => {
    const lp = cert.legPasses.find((p) => p.leg === stage);
    const pass = lp && !lp.pending ? lp : null;
    const cp = s.checkpoints.find((c) => c.stage === stage);
    const sensor = stage > 0 ? evidence.legs.find((l) => l.leg === stage)?.summary : null;
    return { stage, pass, cp, sensor };
  });

  return (
    <div className="min-h-screen bg-canvas py-8 print:bg-white print:py-0">
      {/* Toolbar (not printed) */}
      <div className="mx-auto mb-4 flex max-w-[210mm] items-center justify-between px-4 print:hidden">
        <Link to={`/shipments/${batchId}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> Back to the batch
        </Link>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
        >
          <Printer className="size-4" aria-hidden /> Print / Save as PDF
        </button>
      </div>

      <article className="mx-auto max-w-[210mm] bg-white px-10 py-10 text-[13px] leading-snug shadow-sm print:max-w-none print:px-0 print:py-0 print:shadow-none">
        {/* Header */}
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-4">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold">
              <span className="grid size-7 place-items-center rounded-md bg-brand text-white">
                <Snowflake className="size-4" aria-hidden />
              </span>
              ColdChainSG
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">Cold Chain Quality Certificate</h1>
            <p className="text-muted">Tamper-evident custody and temperature record</p>
          </div>
          <dl className="text-right">
            <dt className="text-xs uppercase tracking-wide text-muted">Certificate no.</dt>
            <dd className="font-mono font-semibold">{number}</dd>
            <dt className="mt-2 text-xs uppercase tracking-wide text-muted">Issued</dt>
            <dd>{fullTime(cert.certificate.issuedAt)}</dd>
          </dl>
        </header>

        {/* Verdict */}
        <section className="mt-5 grid gap-3 sm:grid-cols-2 print:grid-cols-2">
          <div className={`rounded-lg border-2 px-4 py-3 ${status.tone}`}>
            <div className="text-xs uppercase tracking-wide opacity-80">Certificate status</div>
            <div className="text-base font-bold">{status.label}</div>
          </div>
          <div
            className={`rounded-lg border-2 px-4 py-3 ${
              !decision ? "border-line text-muted" : decision.disposition === "released" ? "border-pass bg-pass-soft text-pass" : "border-fail bg-fail-soft text-fail"
            }`}
          >
            <div className="text-xs uppercase tracking-wide opacity-80">QA decision</div>
            <div className="text-base font-bold">
              {!decision ? "PENDING" : decision.disposition === "released" ? "RELEASED FOR SALE" : "REJECTED: NOT TO BE SOLD"}
            </div>
          </div>
        </section>

        {/* Shipment */}
        <Section title="Shipment">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5">
            <Item label="Product">
              {s.details?.product ?? "—"}
              {s.details && ` · ${s.details.quantity} ${s.details.unit}`}
            </Item>
            <Item label="Batch / container">
              Batch #{s.id} · Container <span className="font-mono">{s.containerCode}</span>
            </Item>
            <Item label="Origin seal">
              {s.sealNumber ? <span className="font-mono">{s.sealNumber}</span> : "—"}
              <span className="text-muted"> · applied by {org(s.supplier)} before dispatch; {sealSummary}</span>
            </Item>
            <Item label="Temperature rule">
              ≤ {s.thresholdC} °C, {s.graceMinutes} min grace period
            </Item>
            <Item label="Sensors">{evidence.legs.map((l) => l.sensorId).filter((v, i, a) => a.indexOf(v) === i).join(", ")}</Item>
            <Item label="Supplier">{org(s.supplier)}</Item>
            <Item label="Buyer">{org(s.buyer)}</Item>
            <Item label="Quality Inspector">{org(s.inspector)}</Item>
          </dl>
        </Section>

        {/* Custody & quality checks */}
        <Section title="Custody chain and quality checks">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ink/30 text-[11px] uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-2 font-medium">Stage</th>
                <th className="py-1.5 pr-2 font-medium">Held by</th>
                <th className="py-1.5 pr-2 text-right font-medium">Dispatch</th>
                <th className="py-1.5 pr-2 text-right font-medium">Receipt</th>
                <th className="py-1.5 pr-2 text-right font-medium">Unrefr.</th>
                <th className="py-1.5 pr-2 text-right font-medium">Sensor peak</th>
                <th className="py-1.5 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ stage, pass, cp, sensor }) => (
                <tr key={stage} className="border-b border-line align-top [break-inside:avoid]">
                  <td className="py-2 pr-2">
                    <div className="font-medium">
                      {stage}. {LEG_NAMES[stage]}
                    </div>
                    <div className="text-[11px] text-muted">{HANDOVER_NAMES[stage]}</div>
                  </td>
                  <td className="py-2 pr-2">{org(pass?.custodian)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{cp?.outgoing ? `${cp.outgoing.tempC.toFixed(1)} °C` : "—"}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{cp?.incoming ? `${cp.incoming.tempC.toFixed(1)} °C` : "—"}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{pass ? `${pass.unrefrigeratedMinutes} min` : "—"}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {stage === 0 ? "n/a" : sensor ? `${sensor.maxC.toFixed(1)} °C${sensor.breachMinutes ? ` · ${sensor.breachMinutes} min over` : ""}` : "—"}
                  </td>
                  <td className="py-2">
                    {pass?.status === "pass" ? (
                      <span className="font-semibold text-pass">PASS</span>
                    ) : (
                      <>
                        <span className="font-semibold text-fail">FLAGGED</span>
                        <div className="text-[11px] text-fail">{pass?.reasons.map((r) => REASON_LABELS[r]).join("; ")}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* QA rulings */}
        {cert.claims.length > 0 && (
          <Section title="QA rulings on flagged stages">
            <ul className="space-y-2">
              {[...cert.claims]
                .sort((a, b) => a.leg - b.leg)
                .map((c) => (
                  <li key={c.id} className="[break-inside:avoid]">
                    <div className="font-medium">
                      Stage {c.leg} ({LEG_NAMES[c.leg]}) · held by {org(c.provisionalCustodian)} ·{" "}
                      {c.resolution ? OUTCOME_LABELS[c.resolution.outcome] : <span className="text-warn">Awaiting ruling</span>}
                    </div>
                    {c.resolution && (
                      <div className="text-muted">
                        “{c.resolution.note}” · {org(c.resolution.inspector)}, {fullTime(c.resolution.signedAt)}
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </Section>
        )}

        {/* QA decision & acknowledgement */}
        <Section title="Final decision and receipt">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5">
            <Item label="QA decision">
              {decision ? (
                <>
                  {decision.disposition === "released" ? "Released for sale" : "Rejected (not to be sold)"} by {org(decision.inspector)},{" "}
                  {fullTime(decision.decidedAt)}
                  <div className="text-muted">“{decision.note}”</div>
                </>
              ) : (
                "Pending"
              )}
            </Item>
            <Item label="Buyer's acknowledgement">
              {cert.acknowledgement ? `${org(cert.acknowledgement.buyer)}, ${fullTime(cert.acknowledgement.acknowledgedAt)}` : "Not yet acknowledged"}
            </Item>
          </dl>
        </Section>

        {/* Verification */}
        <Section title="Verification">
          <div className="flex items-start gap-4">
            {qr && <img src={qr} alt="QR code linking to the public verification page" data-testid="verify-qr" className="size-28 shrink-0" />}
            <p className="text-muted">
              Scan the code, or open the link below, to see this certificate and every transaction behind it read live from the blockchain. No
              sign-in is needed. Any difference from this paper copy means it was altered. You can also call{" "}
              <span className="font-mono">getCertificate({cert.batchId})</span> on the CertificateRegistry contract yourself, and compare each sensor
              log's SHA-256 with <span className="font-mono">SensorOracle.verifyFileHash</span>.
              <span className="mt-1 block break-all font-mono text-[11px] text-ink">{verifyUrl}</span>
            </p>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 font-mono text-[11px]">
            <dt className="text-muted">Chain ID</dt>
            <dd>{chain.chainId}</dd>
            <dt className="text-muted">CertificateRegistry</dt>
            <dd className="break-all">{chain.registry}</dd>
            <FragmentRow label="Issued in tx" value={issuance ? `${issuance.hash} (block ${issuance.blockNumber})` : "—"} />
            {evidence.legs.map((l) => (
              <FragmentRow key={l.leg} label={`Leg ${l.leg} sensor log`} value={l.summary?.fileHash ?? "—"} />
            ))}
            {rows.map(({ stage, cp }) =>
              cp?.incoming ? <FragmentRow key={`n${stage}`} label={`Stage ${stage} receipt notes`} value={cp.incoming.notesHash} /> : null,
            )}
          </dl>
        </Section>

        <footer className="mt-8 border-t border-line pt-3 text-[11px] text-muted">
          ColdChainSG records evidence only: it does not hold or move money. Any settlement between the parties happens off-platform.
          Generated {new Date().toLocaleString("en-SG")} · DBA5102 course prototype, simulated sensor data.
        </footer>
      </article>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 [break-inside:avoid-page]">
      <h2 className="mb-2 border-b border-line pb-1 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-all">{value}</dd>
    </>
  );
}
