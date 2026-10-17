// A batch's temperature across its whole journey, against its limit: each stage's readings come
// from that holder's own sensor. Handover gaps (sign-off to sign-in, no sensor) are shaded amber
// and labelled, excursions red and labelled, so nothing relies on colour alone.
// Times are real (the sensors' own timestamps).
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LEG_NAMES } from "../lib/format";
import type { StageEvidence } from "../lib/types";

const SERIES = "#2a78d6";
const MUTED = "#64748b";
const GRID = "#e2e8f0";
const FAIL = "#b91c1c";
const FAIL_SOFT = "#fee2e2";
const AMBER = "#b45309";
const AMBER_SOFT = "#fef3c7";

type Point = { x: number; tempC: number | null; stage: number };

const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function EvidenceChart({ stages, thresholdC }: { stages: StageEvidence[]; thresholdC: number }) {
  const points: Point[] = [];
  for (const s of stages) {
    for (const r of s.readings) points.push({ x: r.at, tempC: r.tempC, stage: s.stage });
    // Break the line across a handover gap: no sensor covers it.
    if (s.gap) points.push({ x: s.gap.from + 0.5, tempC: null, stage: s.stage });
  }
  points.sort((a, b) => a.x - b.x);
  const temps = points.flatMap((p) => (p.tempC === null ? [] : [p.tempC]));
  if (temps.length === 0) return <p className="text-sm text-muted">No sensor readings yet.</p>;

  const yMin = Math.floor(Math.min(0, ...temps));
  const yMax = Math.ceil(Math.max(thresholdC + 1, ...temps) + 0.5);
  const gaps = stages.filter((s) => s.gap && s.gap.to > s.gap.from);
  const breaches = stages.filter((s) => s.summary?.breachStart && s.summary.breachEnd && s.summary.breachEnd > s.summary.breachStart);

  return (
    <figure>
      <div
        className="h-64 w-full"
        role="img"
        aria-label={`Temperature from supplier to buyer: ${temps.length} readings, peak ${Math.max(...temps)} °C, limit ${thresholdC} °C, ${gaps.length} handover gap(s) without sensor coverage.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 20, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={clock}
              tick={{ fill: MUTED, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              minTickGap={40}
            />
            <YAxis domain={[yMin, yMax]} tick={{ fill: MUTED, fontSize: 12 }} tickLine={false} axisLine={false} unit="°" width={44} />
            {gaps.map((s) => (
              <ReferenceArea
                key={`gap${s.stage}`}
                x1={s.gap!.from}
                x2={s.gap!.to}
                fill={AMBER_SOFT}
                fillOpacity={0.9}
                label={{ value: `Handover · ${s.gap!.minutes} min`, position: "insideBottom", fill: AMBER, fontSize: 11, fontWeight: 600 }}
              />
            ))}
            {breaches.map((s) => (
              <ReferenceArea
                key={`breach${s.stage}`}
                x1={s.summary!.breachStart!}
                x2={s.summary!.breachEnd!}
                fill={FAIL_SOFT}
                fillOpacity={0.9}
                label={{ value: `Above limit · ${s.summary!.breachMinutes} min`, position: "insideTop", fill: FAIL, fontSize: 11, fontWeight: 600 }}
              />
            ))}
            {stages
              .filter((s) => s.start)
              .map((s) => (
                <ReferenceLine
                  key={`stage${s.stage}`}
                  x={s.start!}
                  stroke={GRID}
                  label={{ value: LEG_NAMES[s.stage], position: "insideTopLeft", fill: MUTED, fontSize: 11 }}
                />
              ))}
            <ReferenceLine
              y={thresholdC}
              stroke={MUTED}
              strokeDasharray="4 4"
              label={{ value: `Limit ${thresholdC} °C`, position: "insideTopRight", fill: MUTED, fontSize: 12 }}
            />
            <Tooltip
              cursor={{ stroke: MUTED, strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as Point;
                if (p.tempC === null) return null;
                return (
                  <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-md">
                    <div className="text-muted">
                      {clock(p.x)} · {LEG_NAMES[p.stage]}
                    </div>
                    <div className="font-semibold tabular-nums">
                      {p.tempC.toFixed(1)} °C{p.tempC > thresholdC && <span className="ml-1 text-fail">above limit</span>}
                    </div>
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="tempC"
              stroke={SERIES}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              activeDot={{ r: 4, fill: SERIES, stroke: "#fff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-2 text-xs text-muted">
        Each stage's readings come from its holder's own sensor. Amber: on the dock between one party's sign-off and the next one's sign-in,
        with no sensor.
      </figcaption>
    </figure>
  );
}
