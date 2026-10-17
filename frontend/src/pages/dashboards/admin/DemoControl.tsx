// Drives the live demo by deciding what each leg's sensor "records" (there's no real hardware).
// The sensor commits that recording automatically when the leg ends; the custodian then uploads
// their logger file, which must match. Set a leg to "breach" before it ends.
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { unitTitle } from "../../../components/ShipmentCard";
import { ActionFeedback, Badge, Button, Card, Empty, Party, StatusBadge, inputClass } from "../../../components/ui";
import { api } from "../../../lib/api";
import { LEG_NAMES } from "../../../lib/format";
import { useAction, useApi } from "../../../lib/hooks";
import type { LegStatus, Unit } from "../../../lib/types";

export function DemoControl() {
  const { data: legs, reload } = useApi<LegStatus[]>("oracle", "/legs", 4000);
  const { data: units } = useApi<Unit[]>("custody", "/shipments", 5000);
  const sync = useAction();
  const [syncActions, setSyncActions] = useState<{ batchId: number; action: string; leg?: number }[] | null>(null);

  const title = (id: number) => {
    const u = units?.find((x) => x.id === id);
    return u ? unitTitle(u) : `Shipment #${id}`;
  };
  // Newest shipments first; legs in order within each.
  const groups = new Map<number, LegStatus[]>();
  for (const l of [...(legs ?? [])].sort((a, b) => b.shipmentId - a.shipmentId || a.leg - b.leg)) {
    groups.set(l.shipmentId, [...(groups.get(l.shipmentId) ?? []), l]);
  }

  return (
    <div className="space-y-6">
      <Card
        title="What the sensors record"
        subtitle="Stands in for real hardware. Set a leg to Breach before it ends: the sensor commits its recording automatically at the handover, then the custodian uploads their log, which must match."
      >
        {groups.size === 0 ? (
          <Empty>No shipments yet. Once the supplier creates a container, its legs appear here.</Empty>
        ) : (
          <div className="space-y-6">
            {[...groups.entries()].map(([id, rows]) => (
              <div key={id}>
                <h3 className="mb-2 text-sm font-semibold">{title(id)}</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] table-fixed text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="w-[28%] py-2 pr-4 font-medium">Leg</th>
                        <th className="w-[24%] py-2 pr-4 font-medium">Custodian</th>
                        <th className="w-[20%] py-2 pr-4 font-medium">Sensor records</th>
                        <th className="py-2 font-medium">Evidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {rows.map((l) => (
                        <LegRow key={l.leg} leg={l} onChange={reload} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Certificate sync"
        subtitle="Runs automatically every few seconds. Run it now to see the effect immediately."
        action={
          <Button
            variant="secondary"
            busy={sync.busy}
            onClick={() => sync.run(async () => setSyncActions((await api("certificate", "/sync", { body: {} })).actions))}
          >
            <RefreshCw className="size-4" aria-hidden /> Sync now
          </Button>
        }
      >
        <ActionFeedback error={sync.error} />
        {syncActions &&
          (syncActions.length === 0 ? (
            <p className="text-sm text-muted">Nothing new to certify. Everything is already up to date.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {syncActions.map((a, i) => (
                <li key={i}>
                  Batch #{a.batchId}: {a.action}
                  {a.leg ? ` (leg ${a.leg})` : ""}
                </li>
              ))}
            </ul>
          ))}
      </Card>
    </div>
  );
}

function LegRow({ leg, onChange }: { leg: LegStatus; onChange: () => void }) {
  const save = useAction();
  const phase = !leg.custodian ? "Not started" : !leg.end ? "In progress" : null;

  return (
    <tr className="align-top">
      <td className="py-3 pr-4">
        <div className="font-medium">
          Leg {leg.leg} · {LEG_NAMES[leg.leg]}
        </div>
        {phase && <div className="text-xs text-muted">{phase}</div>}
      </td>
      <td className="py-3 pr-4">{leg.custodian ? <Party wallet={leg.custodian} inline /> : <span className="text-muted">—</span>}</td>
      <td className="py-3 pr-4">
        {leg.sensorCommitted ? (
          <Badge tone={leg.recording === "breach" ? "fail" : "pass"}>
            {leg.recording === "breach" ? "Breach recorded" : "Compliant recorded"}
          </Badge>
        ) : (
          <select
            className={inputClass}
            value={leg.recording}
            disabled={save.busy}
            aria-label={`What the sensor records on leg ${leg.leg}`}
            onChange={(e) =>
              save.run(async () => {
                await api("oracle", `/legs/${leg.shipmentId}/${leg.leg}/recording`, {
                  method: "PUT",
                  body: { recording: e.target.value },
                });
                onChange();
              })
            }
          >
            <option value="compliant">Compliant</option>
            <option value="breach">Breach</option>
          </select>
        )}
        {save.error && <p className="mt-1 text-xs text-fail">{save.error}</p>}
      </td>
      <td className="py-3">
        {!leg.end ? (
          <span className="text-muted">—</span>
        ) : !leg.sensorCommitted ? (
          <Badge tone="neutral">Sensor reporting…</Badge>
        ) : (
          <div className="flex flex-wrap gap-1">
            {leg.evidence.map((e) => (
              <span key={e.batchId} className="inline-flex items-center gap-1 text-xs">
                <span className="text-muted">#{e.batchId}</span>
                <StatusBadge status={e.status === "None" ? "awaiting-upload" : e.status} />
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
