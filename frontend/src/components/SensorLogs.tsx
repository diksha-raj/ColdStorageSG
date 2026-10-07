// The logger files a custodian owes: once they hand a shipment over, they upload the sensor log
// for the leg they held. The oracle checks it against the sensor's own commit, so an edited file
// is caught as a hash mismatch.
import { FileUp, Upload } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { LEG_NAMES } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { LegStatus, UploadResult } from "../lib/types";
import { ActionFeedback, Badge, Button, Card, Notice, StatusBadge, inputClass } from "./ui";

const legTitle = (l: LegStatus) =>
  `Leg ${l.leg} · ${LEG_NAMES[l.leg]} · ${l.leg <= 3 ? `Container #${l.shipmentId}` : `Batch #${l.shipmentId}`}`;

export function SensorLogs() {
  const { data: legs, reload } = useApi<LegStatus[]>("oracle", "/legs", 4000);
  // Kept here (not in the row) because a verified leg's row moves to the done list.
  const [last, setLast] = useState<{ leg: LegStatus; result: UploadResult } | null>(null);
  const ended = (legs ?? []).filter((l) => l.end);
  const owed = ended.filter((l) => l.awaitingUpload || !l.sensorCommitted);
  const done = ended.filter((l) => !l.awaitingUpload && l.sensorCommitted);
  if (ended.length === 0) return null;

  return (
    <Card
      title="Sensor logs"
      subtitle="After you hand a shipment over, upload the temperature log for the leg you held. It's checked against the sensor's own record."
    >
      <div className="space-y-4">
        {last && <UploadOutcome {...last} />}
        {owed.map((l) => (
          <OwedLog
            key={`${l.shipmentId}-${l.leg}`}
            leg={l}
            // The message above already explains a mismatch just reported for this leg.
            mismatchShownAbove={!!last && !last.result.matches && last.leg.shipmentId === l.shipmentId && last.leg.leg === l.leg}
            onUploaded={(result) => {
              setLast({ leg: l, result });
              reload();
            }}
          />
        ))}
        {owed.length === 0 && <p className="text-sm text-muted">You're up to date: every log you owe has been accepted.</p>}
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
  onUploaded: (result: UploadResult) => void;
}) {
  const { data: demoFiles } = useApi<{ id: string; label: string }[]>("oracle", "/demo-files");
  const [source, setSource] = useState("compliant"); // a demo file id, or "computer"
  const [file, setFile] = useState<File | null>(null);
  const upload = useAction();
  const mismatch = leg.evidence.some((e) => e.status === "EvidenceMismatch");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    upload.run(async () => {
      // Send the file's exact bytes (base64), so the hash is computed on precisely what you chose.
      const body =
        source === "computer"
          ? { fileBase64: await toBase64(file!), fileName: file!.name }
          : { demoFile: source };
      onUploaded(await api<UploadResult>("oracle", `/legs/${leg.shipmentId}/${leg.leg}/upload`, { body }));
    });
  };

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{legTitle(leg)}</span>
        {!leg.sensorCommitted ? (
          <Badge tone="neutral">Waiting for the sensor…</Badge>
        ) : mismatch ? (
          <StatusBadge status="EvidenceMismatch" />
        ) : (
          <Badge tone="warn">Log needed</Badge>
        )}
      </div>

      {mismatch && !mismatchShownAbove && (
        <div className="mt-3">
          <Notice tone="error">
            The last file uploaded for this leg didn't match what the sensor recorded. Upload the genuine log.
          </Notice>
        </div>
      )}

      {!leg.sensorCommitted ? (
        <p className="mt-2 text-sm text-muted">The sensor reports a few seconds after the handover. Upload will open then.</p>
      ) : (
        <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-72">
            <select className={inputClass} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Logger file">
              {(demoFiles ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  Demo: {f.label}
                </option>
              ))}
              <option value="computer">Choose a CSV from my computer…</option>
            </select>
          </div>
          {source === "computer" && (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted hover:bg-canvas">
              <FileUp className="size-4" aria-hidden />
              <span>{file ? file.name : "Select file"}</span>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
          <Button type="submit" busy={upload.busy} disabled={source === "computer" && !file}>
            <Upload className="size-4" aria-hidden /> Upload log
          </Button>
        </form>
      )}

      <div className="mt-2">
        <ActionFeedback error={upload.error} />
      </div>
    </div>
  );
}

function UploadOutcome({ leg, result }: { leg: LegStatus; result: UploadResult }) {
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
      {legTitle(leg)}: hash mismatch. This file doesn't match what the sensor recorded on the leg. It's been logged
      on-chain as mismatched evidence, and no certificate can be issued until the genuine log is uploaded.
    </Notice>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.readAsDataURL(file);
  });
}
