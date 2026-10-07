// The buyer's QA inspector. Two jobs:
//   1. Rule on each flagged stage: who is responsible (upheld / overturned / compensation agreed).
//      Claims appear here the moment a handover check fails, often while the batch is in transit.
//   2. After delivery, make the final call on the batch: release for sale, or reject.
import { ChevronRight, ShieldAlert } from "lucide-react";
import { Link } from "react-router";
import { certificateState } from "../../components/CertificatePanel";
import { StageDots } from "../../components/StageDots";
import { Card, Empty, Loading, PageHeader, Party, StatusBadge } from "../../components/ui";
import { LEG_NAMES, REASON_LABELS, formatTime, whereIs } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { BatchCertificate, Claim, Unit } from "../../lib/types";

export function InspectorDashboard() {
  const { data: certs, loading } = useApi<BatchCertificate[]>("certificate", "/certificates", 4000);
  const { data: units } = useApi<Unit[]>("custody", "/shipments", 5000);
  if (loading && !certs) return <Loading />;

  const unit = (id: number) => units?.find((u) => u.id === id);
  const all = certs ?? [];
  const openClaims = all.flatMap((b) => b.claims.filter((c) => c.status === "open")).sort((a, b) => a.openedAt - b.openedAt);
  const toDecide = all.filter((b) => b.certificate && !b.decision && b.claims.every((c) => c.status === "resolved"));
  const watch = all.filter((b) => !b.decision);
  const decided = all.filter((b) => b.decision);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quality assurance"
        subtitle="You decide two things: who is responsible for each flagged stage, and whether each batch is fit for sale."
      />

      <Card title="Flagged stages to rule on" subtitle="Opened automatically when a handover check fails or a sensor log shows a breach, even mid-journey.">
        {openClaims.length === 0 ? <Empty>Nothing waiting for a ruling.</Empty> : <ClaimList claims={openClaims} unit={unit} />}
      </Card>

      <Card title="Ready for your final decision" subtitle="Delivered, certified, and every flagged stage ruled on. Release for sale or reject.">
        {toDecide.length === 0 ? (
          <Empty>No batches waiting for a decision.</Empty>
        ) : (
          <BatchList batches={toDecide} unit={unit} action="Decide" />
        )}
      </Card>

      <Card title="Watchlist" subtitle="Your batches as they move: one dot per stage (green passed, red flagged, grey not yet).">
        {watch.length === 0 ? <Empty>No batches in progress.</Empty> : <BatchList batches={watch} unit={unit} />}
      </Card>

      {decided.length > 0 && (
        <Card title="Decided">
          <BatchList batches={decided} unit={unit} />
        </Card>
      )}
    </div>
  );
}

function ClaimList({ claims, unit }: { claims: Claim[]; unit: (id: number) => Unit | undefined }) {
  return (
    <ul className="divide-y divide-line">
      {claims.map((c) => (
        <li key={c.id}>
          <Link to={`/claims/${c.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3 hover:text-brand-dark">
            <span className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 size-4 text-warn" aria-hidden />
              <span>
                <span className="font-medium">
                  Claim #{c.id} · Batch #{c.batchId}
                  {unit(c.batchId)?.details?.product && ` · ${unit(c.batchId)!.details!.product}`} · stage {c.leg} ({LEG_NAMES[c.leg]})
                </span>
                <span className="block text-sm text-fail">{c.reasons.map((r) => REASON_LABELS[r]).join(" · ")}</span>
                <span className="block text-sm text-muted">
                  Held by <Party wallet={c.provisionalCustodian} inline /> · opened {formatTime(c.openedAt)}
                </span>
              </span>
            </span>
            <span className="flex items-center gap-2">
              <StatusBadge status={c.status} />
              <ChevronRight className="size-4 text-muted" aria-hidden />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function BatchList({ batches, unit, action }: { batches: BatchCertificate[]; unit: (id: number) => Unit | undefined; action?: string }) {
  return (
    <ul className="divide-y divide-line">
      {batches.map((b) => {
        const u = unit(b.batchId);
        return (
          <li key={b.batchId}>
            <Link to={`/shipments/${b.batchId}`} className="flex flex-wrap items-center justify-between gap-3 py-3 hover:text-brand-dark">
              <span>
                <span className="font-medium">Batch #{b.batchId}</span>
                {u?.details?.product && <span className="text-muted"> · {u.details.product}</span>}
                {u && <span className="block text-sm text-muted">{whereIs(u)}</span>}
              </span>
              <span className="flex items-center gap-3">
                <StageDots stages={b.stages} />
                <StatusBadge status={certificateState(b)} />
                {action && <span className="text-sm font-medium text-brand-dark">{action}</span>}
                <ChevronRight className="size-4 text-muted" aria-hidden />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
