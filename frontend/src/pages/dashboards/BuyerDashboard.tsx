// The buyer: inspect deliveries on arrival (the last handover check), follow each batch's quality
// record, and acknowledge receipt once their QA team has decided, which closes the batch.
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useAuth } from "../../auth";
import { certificateState } from "../../components/CertificatePanel";
import { HandoverActions } from "../../components/HandoverActions";
import { ShipmentCard } from "../../components/ShipmentCard";
import { StageDots } from "../../components/StageDots";
import { Card, Empty, Loading, PageHeader, StatusBadge } from "../../components/ui";
import { sameAddress, whereIs } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { BatchCertificate, Unit } from "../../lib/types";

export function BuyerDashboard() {
  const { session } = useAuth();
  const me = session!.wallet;
  const { data: units, loading, reload } = useApi<Unit[]>("custody", "/shipments", 4000);
  const { data: certs } = useApi<BatchCertificate[]>("certificate", "/certificates", 4000);

  const myBatches = (units ?? []).filter((u) => u.kind === "batch" && sameAddress(u.buyer, me));
  const certOf = (id: number) => certs?.find((c) => c.batchId === id);
  const incoming = myBatches.filter((u) => sameAddress(u.pendingTo, me));
  const delivered = (u: Unit) => u.stage === "Delivered";

  const toAcknowledge = myBatches.filter((u) => certOf(u.id)?.decision && !certOf(u.id)?.acknowledgement);
  const awaitingQa = myBatches.filter((u) => delivered(u) && !certOf(u.id)?.decision);
  const inTransit = myBatches.filter((u) => !delivered(u) && !sameAddress(u.pendingTo, me));
  const closed = myBatches.filter((u) => certOf(u.id)?.acknowledgement);

  if (loading && !units) return <Loading />;

  return (
    <div className="space-y-6">
      <PageHeader title="Your deliveries" subtitle="Inspect each delivery on arrival, follow its quality record, and close it once your QA team has decided." />

      {incoming.length > 0 && (
        <Card title="Arriving now" subtitle="Inspect the batch and sign what you received. That's the final handover check.">
          <div className="space-y-3">
            {incoming.map((u) => (
              <ShipmentCard key={u.id} unit={u}>
                <HandoverActions unit={u} onDone={reload} />
              </ShipmentCard>
            ))}
          </div>
        </Card>
      )}

      <Card title="Ready to acknowledge" subtitle="Your QA team has released or rejected these. Acknowledge receipt to close the batch.">
        <BatchList units={toAcknowledge} certOf={certOf} empty="Nothing waiting for your acknowledgement." />
      </Card>
      <Card title="Awaiting your QA team" subtitle="Delivered. QA is ruling on any flagged stages and will decide whether the batch is fit for sale.">
        <BatchList units={awaitingQa} certOf={certOf} empty="No deliveries waiting on QA." />
      </Card>
      <Card title="In transit" subtitle="One dot per stage: green passed, red flagged, grey not yet.">
        <BatchList units={inTransit} certOf={certOf} empty="No batches on the way." />
      </Card>
      {closed.length > 0 && (
        <Card title="Closed">
          <BatchList units={closed} certOf={certOf} empty="" />
        </Card>
      )}
    </div>
  );
}

function BatchList({
  units,
  certOf,
  empty,
}: {
  units: Unit[];
  certOf: (id: number) => BatchCertificate | undefined;
  empty: string;
}) {
  if (units.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-line">
      {units.map((u) => (
        <li key={u.id}>
          <Link to={`/shipments/${u.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3 hover:text-brand-dark">
            <span>
              <span className="font-medium">Batch #{u.id}</span>
              <span className="text-muted"> · {u.details?.product ?? "—"}</span>
              <span className="block text-sm text-muted">{whereIs(u)}</span>
            </span>
            <span className="flex items-center gap-3">
              <StageDots stages={certOf(u.id)?.stages} />
              <StatusBadge status={certificateState(certOf(u.id))} />
              <ChevronRight className="size-4 text-muted" aria-hidden />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
