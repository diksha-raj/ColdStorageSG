// Temperature readings for one leg, against the batch's threshold.
// Single series (no legend box: the card title names it). The breach window is shaded in the
// status red AND labelled, so it never relies on colour alone.
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Reading } from "../lib/types";

const SERIES = "#2a78d6"; // categorical slot 1, validated against a light surface
const MUTED = "#64748b";
const GRID = "#e2e8f0";
const FAIL = "#b91c1c";
const FAIL_SOFT = "#fee2e2";

const clock = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

export function EvidenceChart({
  readings,
  thresholdC,
  breachStart,
  breachEnd,
  breachMinutes,
}: {
  readings: Reading[];
  thresholdC: number;
  breachStart?: number | null;
  breachEnd?: number | null;
  breachMinutes?: number;
}) {
  const temps = readings.map((r) => r.tempC);
  const yMin = Math.floor(Math.min(0, ...temps));
  const yMax = Math.ceil(Math.max(thresholdC + 1, ...temps) + 0.5);
  const max = Math.max(...temps);

  return (
    <figure>
      <div
        className="h-56 w-full"
        role="img"
        aria-label={`Temperature over the leg: ${readings.length} readings, peak ${max} °C, limit ${thresholdC} °C${
          breachMinutes ? `, ${breachMinutes} minutes above the limit` : ", never above the limit"
        }.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={readings} margin={{ top: 16, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="at"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={clock}
              tick={{ fill: MUTED, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              minTickGap={48}
            />
            <YAxis
              domain={[yMin, yMax]}
              tick={{ fill: MUTED, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              unit="°"
              width={44}
            />
            {breachStart && breachEnd && breachEnd > breachStart && (
              <ReferenceArea
                x1={breachStart}
                x2={breachEnd}
                fill={FAIL_SOFT}
                fillOpacity={0.9}
                label={{ value: `Breach · ${breachMinutes} min`, position: "insideTop", fill: FAIL, fontSize: 12, fontWeight: 600 }}
              />
            )}
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
                const r = payload[0].payload as Reading;
                const over = r.tempC > thresholdC;
                return (
                  <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-md">
                    <div className="text-muted">{clock(r.at)}</div>
                    <div className="font-semibold tabular-nums">
                      {r.tempC.toFixed(1)} °C{over && <span className="ml-1 text-fail">above limit</span>}
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
              activeDot={{ r: 4, fill: SERIES, stroke: "#fff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-2 text-xs text-muted">
        Readings from the uploaded logger file, aligned so the first reading falls at the start of this leg.
      </figcaption>
    </figure>
  );
}
