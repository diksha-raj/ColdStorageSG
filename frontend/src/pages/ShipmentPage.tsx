import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CertificatePanel } from "../components/CertificatePanel";
import { CheckpointTimeline } from "../components/CheckpointTimeline";
import { QualityLog } from "../components/QualityLog";
import { HandoverActions } from "../components/HandoverActions";
import { LegEvidence } from "../components/LegEvidence";
import { ShipmentCard, unitTitle } from "../components/ShipmentCard";
import { Badge, Card, Loading, Notice, PageHeader, Party } from "../components/ui";
import { LEG_NAMES, STAGE_LABELS, formatDate, formatTime, whereIs } from "../lib/format";
import { useAuth } from "../auth";
import { useApi } from "../lib/hooks";
import type { BatchCertificate, ShipmentDetail } from "../lib/types";

export function ShipmentPage() {
  const { id } = useParams();
  const { session } = useAuth();
  const { data: s, error, loading, reload } = useApi<ShipmentDetail>("custody", `/shipments/${id}`, 5000);
  const isBatch = s?.kind === "batch";
  const { data: cert } = useApi<BatchCertificate>("certificate", isBatch ? `/certificates/${id}` : null, 5000);

  if (loading && !s) return <Loading />;
  if (error || !s) return <Notice tone="error">{error ?? "Shipment not found."}</Notice>;
  // The current holder can log spot readings and report issues until they hand over (not once unloaded or delivered).
  const holding = session?.wallet === s.custodian && !s.unloadedAt && !s.inContainer && s.stage !== "Delivered";

  return (
    <div className="space-y-6">
      <Link to="/app" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Dashboard
      </Link>
      <PageHeader
        title={unitTitle(s)}
        subtitle={`${s.kind === "batch" ? (s.containerCode ? `Shipped in container ${s.containerCode}` : "Not loaded yet") : `${s.batches.length} batch(es)`}${s.sealNumber ? ` · seal ${s.sealNumber}` : ""}`}
        action={<Badge tone="brand">{s.unloadedAt ? "Unloaded at the cold store" : whereIs(s)}</Badge>}
      />

      {/* Hidden when the signed-in wallet has nothing to do on this shipment. */}
      <div className="rounded-2xl border border-brand/30 bg-brand-soft/50 p-5 empty:hidden">
        <HandoverActions unit={s} onDone={reload} />
      </div>
      {holding && <QualityLog unitId={s.id} limitC={s.thresholdC} />}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Details" className="lg:col-span-2">
          <dl className="space-y-3 text-sm">
            {s.kind === "container" ? (
              <>
                <Row label="Mode">{s.details ? `${s.details.mode === "sea" ? "Sea" : "Air"} · ${s.details.voyage}` : "—"}</Row>
                <Row label="Route">{s.details ? `${s.details.origin} → ${s.details.destination}` : "—"}</Row>
                <Row label="Departure">{formatDate(s.details?.departureDate)}</Row>
                <Row label="Opened by">
                  <Party wallet={s.holders[0]} />
                </Row>
              </>
            ) : (
              <>
                <Row label="Product">
                  {s.details?.product ?? "—"} {s.details && `· ${s.details.quantity} ${s.details.unit}`}
                </Row>
                <Row label="Temperature rule">
                  ≤ {s.thresholdC} °C, {s.graceMinutes} min grace period
                </Row>
                <Row label="Buyer">
                  <Party wallet={s.buyer} />
                </Row>
                <Row label="Quality Inspector">
                  <Party wallet={s.inspector} />
                </Row>
                <Row label="Supplier">
                  <Party wallet={s.supplier} />
                </Row>
              </>
            )}
            <Row label="Sensors">
              {s.sensors.length === 0 ? (
                "None registered yet"
              ) : (
                <ul className="space-y-1">
                  {s.sensors.map((x) => (
                    <li key={x.stage}>
                      <span className="text-muted">{LEG_NAMES[x.stage]}: </span>
                      <span className="font-mono">{x.sensorId}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Row>
          </dl>
        </Card>

        <Card title="Custody timeline" subtitle="Each entry is the moment the holder signed it in, recorded on-chain." className="lg:col-span-3">
          <ol className="relative space-y-4 border-l border-line pl-5">
            {s.history.map((h, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[26px] top-1 size-3 rounded-full border-2 border-white bg-brand ring-1 ring-brand" />
                <div className="text-sm font-medium">{STAGE_LABELS[h.stage]}</div>
                <div className="text-sm">
                  <Party wallet={h.custodian} inline />
                  <span className="text-muted"> · {formatTime(h.startedAt)}</span>
                </div>
              </li>
            ))}
            {s.pendingTo && (
              <li className="relative">
                <span className="absolute -left-[26px] top-1 size-3 rounded-full border-2 border-white bg-warn-soft ring-1 ring-warn" />
                <div className="text-sm font-medium text-warn">Handover pending</div>
                <div className="text-sm">
                  Signed off; waiting for <Party wallet={s.pendingTo} inline /> to sign it in
                </div>
              </li>
            )}
          </ol>
        </Card>
      </div>

      <CheckpointTimeline
        checkpoints={s.checkpoints}
        stages={cert?.stages}
        totalStages={s.kind === "batch" ? 5 : 2}
      />

      {s.kind === "container" ? (
        <Card title="Batches">
          <div className="space-y-3">
            {s.batches.map((b) => (
              <ShipmentCard key={b.id} unit={b} />
            ))}
          </div>
        </Card>
      ) : (
        <>
          <CertificatePanel batchId={s.id} buyer={s.buyer} inspector={s.inspector} />
          <LegEvidence batchId={s.id} />
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="col-span-2">{children}</dd>
    </div>
  );
}

