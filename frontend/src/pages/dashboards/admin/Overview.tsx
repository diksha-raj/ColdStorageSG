// Impact / KPI overview, computed from the live on-chain records.
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Loading, Stat, StatusBadge } from "../../../components/ui";
import { LEG_NAMES, REASON_LABELS } from "../../../lib/format";
import { useApi } from "../../../lib/hooks";

type Kpis = {
  batches: number;
  certified: number;
  clean: number;
  flagged: number;
  resolved: number;
  cleanRate: number | null;
  acknowledged: number;
  claims: { open: number; resolved: number };
  avgResolutionHours: number | null;
  outcomes: { upheld: number; overturned: number; compensation_agreed: number };
  claimsByLeg: { leg: number; claims: number }[];
  checkpoints: { completed: number; flagged: number };
  flagReasons: Record<string, number>;
  gapMinutesByStage: { leg: number; minutes: number }[];
  dispositions: { released: number; rejected: number; awaiting: number };
};

const SERIES = "#2a78d6"; // validated categorical slot 1
const MUTED = "#64748b";
const GRID = "#e2e8f0";

function duration(hours: number | null) {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  return `${hours.toFixed(1)} h`;
}

export function Overview() {
  const { data: k } = useApi<Kpis>("certificate", "/kpis", 8000);
  if (!k) return <Loading />;

  const legData = k.claimsByLeg.map((d) => ({ ...d, name: LEG_NAMES[d.leg] }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Handover checks"
          value={k.checkpoints.completed}
          hint={`${k.checkpoints.flagged} failed · ${k.checkpoints.completed - k.checkpoints.flagged} passed`}
        />
        <Stat label="QA decisions" value={`${k.dispositions.released} / ${k.dispositions.rejected}`} hint={`released / rejected · ${k.dispositions.awaiting} awaiting`} />
        <Stat label="Open claims" value={k.claims.open} hint={`${k.claims.resolved} ruled on by QA`} />
        <Stat label="Avg. time to rule" value={duration(k.avgResolutionHours)} hint="Stage flagged → QA ruling" />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Flagged stages by custody stage" subtitle="Where in the chain problems happen." className="lg:col-span-3">
          <div className="h-56" role="img" aria-label={`Claims by leg: ${legData.map((d) => `${d.name} ${d.claims}`).join(", ")}.`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={legData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }} barCategoryGap="30%">
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="name" tick={{ fill: MUTED, fontSize: 12 }} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis allowDecimals={false} tick={{ fill: MUTED, fontSize: 12 }} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "#f1f5f9" }}
                  content={({ active, payload }) =>
                    active && payload?.length ? (
                      <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-md">
                        <div className="text-muted">{(payload[0].payload as any).name}</div>
                        <div className="font-semibold tabular-nums">{payload[0].value} claim(s)</div>
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="claims" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <h3 className="mb-2 mt-6 text-sm font-semibold">Minutes on the dock at handover, unrefrigerated, by the stage it closed</h3>
          <dl className="grid grid-cols-5 gap-2 text-center text-sm">
            {k.gapMinutesByStage.map((d) => (
              <div key={d.leg} className="rounded-lg bg-canvas px-2 py-2">
                <dd className="font-semibold tabular-nums">{d.minutes}</dd>
                <dt className="text-xs text-muted">{LEG_NAMES[d.leg]}</dt>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Certificates and outcomes" className="lg:col-span-2">
          <h3 className="mb-2 text-sm font-semibold">Why stages were flagged</h3>
          <dl className="space-y-2 text-sm">
            {Object.entries(k.flagReasons).map(([reason, count]) => (
              <div key={reason} className="flex items-center justify-between">
                <dt>{REASON_LABELS[reason]}</dt>
                <dd className="font-semibold tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mb-2 mt-6 text-sm font-semibold">Certificates</h3>
          <dl className="space-y-3 text-sm">
            <Row status="clean" value={k.clean} />
            <Row status="flagged" value={k.flagged} />
            <Row status="resolved" value={k.resolved} />
            <Row status="acknowledged" value={k.acknowledged} />
          </dl>
          <h3 className="mb-2 mt-6 text-sm font-semibold">QA rulings</h3>
          <dl className="space-y-3 text-sm">
            <Row status="upheld" value={k.outcomes.upheld} />
            <Row status="overturned" value={k.outcomes.overturned} />
            <Row status="compensation_agreed" value={k.outcomes.compensation_agreed} />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Row({ status, value }: { status: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <dt>
        <StatusBadge status={status} />
      </dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
