// Five dots, one per stage (origin + 4 legs): green passed, red flagged, grey not checked yet.
import { HANDOVER_NAMES, REASON_LABELS } from "../lib/format";
import type { StageStatus } from "../lib/types";

export function StageDots({ stages }: { stages?: StageStatus[] }) {
  if (!stages) return null;
  return (
    <span className="inline-flex items-center gap-1" aria-label="Stage results">
      {stages.map((s) => {
        const state = s.reasons.length ? "flagged" : s.checkpointDone && s.sensorDone ? "passed" : s.checkpointDone ? "checked" : "pending";
        const color = { flagged: "bg-fail", passed: "bg-pass", checked: "bg-pass/50", pending: "bg-line" }[state];
        const title = `${HANDOVER_NAMES[s.stage]}: ${
          state === "flagged" ? s.reasons.map((r) => REASON_LABELS[r]).join(", ") : state === "pending" ? "not handed over yet" : state === "checked" ? "handover passed, sensor log pending" : "passed"
        }`;
        return <span key={s.stage} title={title} className={`size-2.5 rounded-full ${color}`} />;
      })}
    </span>
  );
}
