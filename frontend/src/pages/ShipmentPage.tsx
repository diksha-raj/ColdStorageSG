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
import { STAGE_LABELS, formatDate, formatTime } from "../lib/format";
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
  // The current holder can log readings and report issues until they hand over (not once split or delivered).
  const holding = session?.wallet === s.custodian && !s.splitAt && s.stage !== "Delivered";

  return (
    <div className="space-y-6">
      <Link to="/app" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Dashboard
      </Link>
      <PageHeader
        title={unitTitle(s)}
        subtitle={`${s.kind === "batch" ? `Part of container ${s.containerCode}` : `${s.batches.length} batch(es)`}${s.sealNumber ? ` · seal ${s.sealNumber}` : ""}`}
        action={<Badge tone="brand">{s.splitAt ? "Split into batches" : STAGE_LABELS[s.stage]}</Badge>}
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
                <Row label="Origin">{s.details?.origin ?? "—"}</Row>
                <Row label="Departure">{formatDate(s.details?.departureDate)}</Row>
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
              </>
            )}
            <Row label="Supplier">
              <Party wallet={s.supplier} />
            </Row>
            <Row label="Sensor">
              <span className="font-mono">{s.sensorId}</span>
            </Row>
          </dl>
        </Card>

        <Card title="Custody timeline" subtitle="Each handover is recorded on-chain when the next custodian accepts." className="lg:col-span-3">
          <ol className="relative space-y-4 border-l border-line pl-5">
            {s.history.map((h, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[26px] top-1 size-3 rounded-full border-2 border-white bg-brand ring-1 ring-brand" />
                <div className="text-sm font-medium">
                  {i > 0 && h.stage === "ColdStore" && s.history[i - 1].stage === "ColdStore"
                    ? "Split from container"
                    : STAGE_LABELS[h.stage]}
                </div>
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
                  Waiting for <Party wallet={s.pendingTo} inline /> to accept
                </div>
              </li>
            )}
          </ol>
        </Card>
      </div>

      <CheckpointTimeline
        checkpoints={s.checkpoints}
        stages={cert?.stages}
        totalStages={s.kind === "batch" ? 5 : 3}
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

