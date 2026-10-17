// The handover checks of a shipment: both parties' signed checks side by side (the sender's
// sign-off is the exit time, the receiver's sign-in the entry time), what they logged while they
// held it, and which stages were flagged and why. Answers "where did it go wrong?"
import { CheckCircle2, CircleAlert, Clock, Thermometer } from "lucide-react";
import { HANDOVER_NAMES, ISSUE_CATEGORIES, LEG_NAMES, REASON_LABELS, formatTime } from "../lib/format";
import type { Check, Checkpoint, StageStatus } from "../lib/types";
import { CheckSummary } from "./HandoverActions";
import { Badge, Card, Party } from "./ui";

const DISCREPANCY_C = 2;

export function CheckpointTimeline({
  checkpoints,
  stages,
  totalStages,
  title = "Handover quality checks",
  showSummary = true,
}: {
  checkpoints: Checkpoint[];
  stages?: StageStatus[]; // per-batch verdicts (batches only); containers show the raw checks
  totalStages: number;
  title?: string;
  showSummary?: boolean;
}) {
  const done = checkpoints.filter((cp) => cp.incoming);
  const flagged = stages?.filter((s) => s.reasons.length) ?? [];
  const first = flagged[0];

  return (
    <Card title={title} subtitle="Each handover is signed by both sides: what the sender handed over and what the receiver found.">
      {stages && showSummary && (
        <div className="mb-5">
          {first ? (
            <div className="flex items-start gap-3 rounded-xl border border-fail/20 bg-fail-soft px-4 py-3 text-fail">
              <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div>
                <div className="font-semibold">
                  {flagged.length} of {totalStages} stages flagged
                </div>
                <div className="text-sm">
                  Problem first detected while with <strong>{LEG_NAMES[first.stage]}</strong>:{" "}
                  {first.reasons.map((r) => REASON_LABELS[r].toLowerCase()).join(", ")}.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-pass/20 bg-pass-soft px-4 py-3 text-pass">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div className="font-semibold">
                {done.length === totalStages
                  ? `All ${totalStages} handover checks passed`
                  : `${done.length} of ${totalStages} handover checks done, all passed so far`}
              </div>
            </div>
          )}
        </div>
      )}

      <ol className="space-y-4">
        {checkpoints.map((cp) => {
          const reasons = stages?.find((s) => s.stage === cp.stage)?.reasons ?? [];
          return (
            <li key={cp.stage} className={`rounded-xl border p-4 ${reasons.length ? "border-fail/30" : "border-line"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  <span className="text-muted">Stage {cp.stage} · </span>
                  {HANDOVER_NAMES[cp.stage]}
                </span>
                {!cp.incoming ? (
                  <Badge tone="neutral">
                    <Clock className="size-3" aria-hidden /> Not handed over yet
                  </Badge>
                ) : reasons.length ? (
                  <span className="flex flex-wrap gap-1">
                    {reasons.map((r) => (
                      <Badge key={r} tone="fail">
                        {REASON_LABELS[r]}
                      </Badge>
                    ))}
                  </span>
                ) : stages ? (
                  <Badge tone="pass">Passed</Badge>
                ) : null}
              </div>

              {cp.incoming && cp.outgoing && (
                <>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <Side title="Sign-off" check={cp.outgoing} />
                    <Side title="Sign-in" check={cp.incoming} />
                  </div>
                  {Math.abs(cp.outgoing.tempC - cp.incoming.tempC) > DISCREPANCY_C && (
                    <p className="mt-2 text-xs text-warn">
                      The two probe readings differ by {Math.abs(cp.outgoing.tempC - cp.incoming.tempC).toFixed(1)} °C.
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Side({ title, check }: { title: string; check: Check }) {
  const sealed = check.sealed;
  return (
    <div className="rounded-lg bg-canvas p-3 text-sm">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
        {title} · <Party wallet={check.by} inline /> · {formatTime(check.checkedAt)}
      </div>
      <CheckSummary check={check} />
      {sealed?.note && <p className="mt-1.5 text-muted">“{sealed.note}”</p>}
      {sealed?.readings && sealed.readings.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-brand-dark">{sealed.readings.length} spot reading(s) while held</summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {sealed.readings.map((r, i) => (
              <li key={i} className="flex items-center gap-1.5 tabular-nums">
                <Thermometer className="size-3 text-muted" aria-hidden />
                <strong>{r.tempC.toFixed(1)} °C</strong>
                <span className="text-muted">
                  {new Date(r.takenAt).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {r.note && ` · ${r.note}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {sealed?.issues && sealed.issues.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs">
          {sealed.issues.map((x, i) => (
            <li key={i}>
              <span className="font-medium text-warn">{ISSUE_CATEGORIES[x.category] ?? x.category}</span>
              {x.unrefrigeratedMinutes > 0 && ` · ${x.unrefrigeratedMinutes} min affected`} · {x.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
