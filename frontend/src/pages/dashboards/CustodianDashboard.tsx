// Cargo, destination freight handler, cold store and reefer truck share one dashboard:
// accept what's coming to you, hand on what you hold (and split, at the cold store), then upload
// the sensor log for each leg you held.
import { useAuth } from "../../auth";
import { HandoverActions } from "../../components/HandoverActions";
import { QualityLog } from "../../components/QualityLog";
import { SensorLogs } from "../../components/SensorLogs";
import { ShipmentCard } from "../../components/ShipmentCard";
import { Card, Empty, Loading, PageHeader } from "../../components/ui";
import { ROLE_LABELS, type Role, sameAddress } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import type { Unit } from "../../lib/types";

const INTRO: Partial<Record<Role, string>> = {
  CARRIER: "Inspect containers on pickup, log temperatures and issues in transit, then check and hand over at the destination port or airport.",
  HANDLER: "Inspect containers on arrival, log what happens on the ground, then check and hand over to the cold store.",
  COLD_STORE: "Inspect containers on arrival, split them into batches, and check each batch out to a reefer truck.",
  TRUCK: "Inspect batches on pickup, log temperatures on the road, and check each one out to its buyer.",
};

export function CustodianDashboard({ role }: { role: Role }) {
  const { session } = useAuth();
  const { data: units, loading, reload } = useApi<Unit[]>("custody", "/shipments", 4000);
  const me = session!.wallet;

  const incoming = (units ?? []).filter((u) => sameAddress(u.pendingTo, me));
  // Split containers are done: their batches carry on separately.
  const holding = (units ?? []).filter((u) => sameAddress(u.custodian, me) && !u.splitAt);

  return (
    <div className="space-y-6">
      <PageHeader title={`${ROLE_LABELS[role]} dashboard`} subtitle={INTRO[role]} />
      {loading && !units ? (
        <Loading />
      ) : (
        <>
          <Card title="Incoming handovers" subtitle="Accepting records on-chain that you now hold the shipment.">
            {incoming.length === 0 ? (
              <Empty>Nothing is waiting for you to accept.</Empty>
            ) : (
              <div className="space-y-3">
                {incoming.map((u) => (
                  <ShipmentCard key={u.id} unit={u}>
                    <HandoverActions unit={u} onDone={reload} />
                  </ShipmentCard>
                ))}
              </div>
            )}
          </Card>
          <SensorLogs />
          <Card title="In your custody">
            {holding.length === 0 ? (
              <Empty>You aren't holding any shipments right now.</Empty>
            ) : (
              <div className="space-y-3">
                {holding.map((u) => (
                  <ShipmentCard key={u.id} unit={u}>
                    <div className="space-y-3">
                      <QualityLog unitId={u.id} limitC={u.thresholdC} />
                      <HandoverActions unit={u} onDone={reload} />
                    </div>
                  </ShipmentCard>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
