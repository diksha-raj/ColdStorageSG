// The sensor logs for legs a custodian has handed over. Logs are normally uploaded in the handover
// form itself and checked against the sensor's own commit once the receiver accepts. This card shows
// that check, and lets the custodian upload (or replace, after a mismatch) a log for an ended leg.
import { Upload } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LEG_NAMES } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { LegStatus } from "../lib/types";
import { type LogChoice, LogPicker, type UploadResponse, emptyLogChoice, logChoiceReady, uploadLog } from "./LogPicker";
import { ActionFeedback, Badge, Button, Card, Notice, StatusBadge } from "./ui";

const legTitle = (l: LegStatus) =>
  `Leg ${l.leg} · ${LEG_NAMES[l.leg]} · ${l.leg <= 3 ? `Container ${l.containerCode}` : `Batch #${l.shipmentId}`}`;

const verified = (l: LegStatus) => l.evidence.length > 0 && l.evidence.every((e) => e.status === "Verified");

export function SensorLogs() {
  const { data: legs, reload } = useApi<LegStatus[]>("oracle", "/legs", 4000);
  // Kept here (not in the row) because a verified leg's row moves to the done list.
  const [last, setLast] = useState<{ leg: LegStatus; result: UploadResponse } | null>(null);
  const ended = (legs ?? []).filter((l) => l.end);
  const checking = ended.filter((l) => l.stagedUpload && !verified(l));
  const owed = ended.filter((l) => !l.stagedUpload && !verified(l));
  const done = ended.filter(verified);
  if (ended.length === 0) return null;

  return (
    <Card
      title="Sensor logs"
      subtitle="Each leg's temperature log is uploaded when you hand over, then checked against the sensor's own record once the receiver accepts."
    >
      <div className="space-y-4">
        {last && <UploadOutcome {...last} />}
        {checking.map((l) => (
          <div key={`${l.shipmentId}-${l.leg}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-4">
            <span>
              <span className="font-medium">{legTitle(l)}</span>
              <span className="block text-sm text-muted">
                Uploaded at handover: <span className="font-mono">{l.stagedUpload!.fileName}</span>
              </span>
            </span>
            <Badge tone="neutral">{l.sensorCommitted ? "Checking…" : "Waiting for the sensor…"}</Badge>
          </div>
        ))}
        {owed.map((l) => (
          <OwedLog
            key={`${l.shipmentId}-${l.leg}`}
            leg={l}
            // The message above already explains a mismatch just reported for this leg.
            mismatchShownAbove={!!last && !last.result.staged && !last.result.matches && last.leg.shipmentId === l.shipmentId && last.leg.leg === l.leg}
            onUploaded={(result) => {
              setLast({ leg: l, result });
              reload();
            }}
          />
        ))}
        {owed.length === 0 && checking.length === 0 && (
          <p className="text-sm text-muted">You're up to date: every log you owe has been accepted.</p>
        )}
        {done.length > 0 && (
          <ul className="divide-y divide-line border-t border-line pt-2 text-sm">
            {done.map((l) => (
              <li key={`${l.shipmentId}-${l.leg}`} className="flex items-center justify-between py-2">
                <span>{legTitle(l)}</span>
                <StatusBadge status="Verified" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function OwedLog({
  leg,
  mismatchShownAbove,
  onUploaded,
}: {
  leg: LegStatus;
  mismatchShownAbove: boolean;
  onUploaded: (result: UploadResponse) => void;
}) {
  const [choice, setChoice] = useState<LogChoice>(emptyLogChoice());
  const upload = useAction();
  const mismatch = leg.evidence.some((e) => e.status === "EvidenceMismatch");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    upload.run(async () => onUploaded(await uploadLog(leg.shipmentId, leg.leg, choice)));
  };

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{legTitle(leg)}</span>
        {mismatch ? <StatusBadge status="EvidenceMismatch" /> : <Badge tone="warn">Log needed</Badge>}
      </div>

      {mismatch && !mismatchShownAbove && (
        <div className="mt-3">
          <Notice tone="error">The last file uploaded for this leg didn't match what the sensor recorded. Upload the genuine log.</Notice>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
        <LogPicker value={choice} onChange={setChoice} label="Logger file" />
        <Button type="submit" busy={upload.busy} disabled={!logChoiceReady(choice)}>
          <Upload className="size-4" aria-hidden /> Upload log
        </Button>
      </form>
      <div className="mt-2">
        <ActionFeedback error={upload.error} />
      </div>
    </div>
  );
}

function UploadOutcome({ leg, result }: { leg: LegStatus; result: UploadResponse }) {
  if (result.staged) {
    return <Notice tone="info">{legTitle(leg)}: log uploaded. It's checked against the sensor's record as soon as the sensor reports.</Notice>;
  }
  if (result.matches) {
    const breach = result.results.find((r) => r.breachMinutes > 0);
    return (
      <Notice tone="success">
        {legTitle(leg)}: your log matches the sensor's record, so the evidence is verified.
        {breach && ` It shows a peak of ${breach.maxC.toFixed(1)} °C, so the leg will be checked against each batch's limit.`}
      </Notice>
    );
  }
  return (
    <Notice tone="error">
      {legTitle(leg)}: hash mismatch. This file doesn't match what the sensor recorded on the leg. It's been logged on-chain as
      mismatched evidence, and no certificate can be issued until the genuine log is uploaded.
    </Notice>
  );
}
