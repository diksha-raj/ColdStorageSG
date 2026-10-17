import { Container, Package } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatDate, whereIs } from "../lib/format";
import type { Unit } from "../lib/types";
import { Badge, Party } from "./ui";

export function unitTitle(u: Unit) {
  if (u.kind === "container") {
    const route = u.details?.origin ? ` · ${u.details.origin} → ${u.details.destination}` : "";
    return `Container ${u.containerCode}${route}`;
  }
  return `Batch #${u.id}${u.details?.product ? ` · ${u.details.product}` : ""}`;
}

/** A compact row for one container or batch, with an optional action area. */
export function ShipmentCard({ unit, children, status }: { unit: Unit; children?: ReactNode; status?: ReactNode }) {
  const Icon = unit.kind === "container" ? Container : Package;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ice text-sky-700">
            <Icon className="size-4.5" aria-hidden />
          </span>
          <div>
            <Link to={`/shipments/${unit.id}`} className="font-medium hover:text-brand-dark hover:underline">
              {unitTitle(unit)}
            </Link>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <span>{unit.unloadedAt ? "Unloaded at the cold store" : whereIs(unit)}</span>
              {unit.details?.voyage && (
                <span>
                  {unit.details.mode === "sea" ? "By sea" : "By air"} · {unit.details.voyage}
                </span>
              )}
              {unit.details?.departureDate && <span>Departs {formatDate(unit.details.departureDate)}</span>}
              {unit.details?.quantity !== undefined && (
                <span>
                  {unit.details.quantity} {unit.details.unit}
                </span>
              )}
              {unit.thresholdC !== undefined && (
                <span>
                  ≤ {unit.thresholdC} °C · {unit.graceMinutes} min grace
                </span>
              )}
              {unit.sensorId && <span className="font-mono text-xs leading-5">Sensor {unit.sensorId}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status}
          {unit.pendingTo && <Badge tone="warn">Handover pending</Badge>}
        </div>
      </div>
      {unit.custodian && !unit.unloadedAt && (
        <div className="mt-3 text-sm">
          <span className="text-muted">Held by </span>
          <Party wallet={unit.custodian} inline />
        </div>
      )}
      {children && <div className="mt-4 border-t border-line pt-4">{children}</div>}
    </div>
  );
}
