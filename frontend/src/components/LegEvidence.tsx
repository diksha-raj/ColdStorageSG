// Sensor evidence for each leg: who held the batch, the sensor's committed hash vs the oracle's,
// summary numbers, the readings chart, and a one-click on-chain verification of the raw file.
import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { fetchBytes } from "../lib/api";
import { readContract, sha256Hex } from "../lib/chain";
import { LEG_NAMES, formatTime, shortHash } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { Evidence } from "../lib/types";
import { EvidenceChart } from "./EvidenceChart";
import { ActionFeedback, Button, Card, Empty, Loading, Party, StatusBadge } from "./ui";

export function LegEvidence({ batchId, onlyLeg }: { batchId: number; onlyLeg?: number }) {
  const { data, loading } = useApi<Evidence>("oracle", `/evidence/${batchId}`, 5000);
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const legs = onlyLeg ? data.legs.filter((l) => l.leg === onlyLeg) : data.legs;
  return (
    <div className="space-y-4">
      {legs.map((leg) => (
        <Card
          key={leg.leg}
          title={`Leg ${leg.leg} · ${LEG_NAMES[leg.leg]} temperature`}
          subtitle={
            leg.start
              ? `${formatTime(leg.start)} → ${leg.end ? formatTime(leg.end) : "in progress"} · sensor ${leg.sensorId}`
              : "Not started yet"
          }
          action={<StatusBadge status={leg.summary?.status ?? "awaiting"} />}
        >
          {leg.custodian && (
            <div className="mb-4 text-sm">
              <span className="text-muted">Custodian on this leg: </span>
              <Party wallet={leg.custodian} inline />
            </div>
          )}

          {leg.summary ? (
            <>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Metric label="Peak" value={`${leg.summary.maxC.toFixed(1)} °C`} alert={leg.summary.maxC > data.thresholdC} />
                <Metric label="Lowest" value={`${leg.summary.minC.toFixed(1)} °C`} />
                <Metric
                  label="Longest excursion"
                  value={`${leg.summary.breachMinutes} min`}
                  hint={`Grace period ${data.graceMinutes} min`}
                  alert={leg.summary.breachMinutes > data.graceMinutes}
                />
                <Metric label="Limit" value={`${data.thresholdC} °C`} />
              </dl>

              {leg.summary.status === "EvidenceMismatch" && (
                <p className="mt-4 rounded-lg border border-fail/20 bg-fail-soft px-3 py-2 text-sm text-fail">
                  The logger file the custodian uploaded doesn't match the hash the sensor committed. It may have
                  been edited, so no certificate can be issued for this leg until the genuine log is uploaded.
                </p>
              )}

              <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
                <HashRow label="Sensor committed" hash={leg.committedHash} />
                <HashRow
                  label="Uploaded file"
                  hash={leg.summary.fileHash}
                  mismatch={leg.summary.fileHash !== leg.committedHash}
                />
              </dl>

              {leg.latestUpload && (
                <div className="mt-5">
                  <p className="mb-2 text-xs text-muted">
                    Logger file <span className="font-mono">{leg.latestUpload.fileName}</span> uploaded by{" "}
                    <Party wallet={leg.latestUpload.uploadedBy} inline />
                  </p>
                  <EvidenceChart
                    readings={leg.latestUpload.readings}
                    thresholdC={data.thresholdC}
                    breachStart={leg.summary.breachStart}
                    breachEnd={leg.summary.breachEnd}
                    breachMinutes={leg.summary.breachMinutes}
                  />
                  <VerifyFile batchId={batchId} leg={leg.leg} uploadId={leg.latestUpload.id} />
                </div>
              )}
            </>
          ) : (
            <Empty>No sensor evidence submitted for this leg yet.</Empty>
          )}
        </Card>
      ))}
    </div>
  );
}

function Metric({ label, value, hint, alert }: { label: string; value: string; hint?: string; alert?: boolean }) {
  return (
    <div className="rounded-lg bg-canvas px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-semibold tabular-nums ${alert ? "text-fail" : ""}`}>{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}

function HashRow({ label, hash, mismatch }: { label: string; hash: string | null; mismatch?: boolean }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className={`font-mono ${mismatch ? "text-fail" : ""}`} title={hash ?? undefined}>
        {shortHash(hash)}
      </dd>
    </div>
  );
}

/** Downloads the replayed CSV, hashes it in the browser, and asks the contract whether it matches. */
function VerifyFile({ batchId, leg, uploadId }: { batchId: number; leg: number; uploadId: number }) {
  const verify = useAction();
  const [result, setResult] = useState<{ hash: string; matches: boolean } | null>(null);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <Button
        variant="secondary"
        busy={verify.busy}
        onClick={() =>
          verify.run(async () => {
            const bytes = await fetchBytes("oracle", `/uploads/${uploadId}/raw`);
            const hash = await sha256Hex(bytes);
            const oracle = await readContract("SensorOracle");
            setResult({ hash, matches: await oracle.verifyFileHash(batchId, leg, hash) });
          })
        }
      >
        <Fingerprint className="size-4" aria-hidden /> Verify file on-chain
      </Button>
      {result && (
        <span className={result.matches ? "text-pass" : "text-fail"}>
          {result.matches
            ? `Matches the sensor's on-chain commit (${shortHash(result.hash)}).`
            : `Does NOT match the sensor's on-chain commit (${shortHash(result.hash)}).`}
        </span>
      )}
      <ActionFeedback error={verify.error} />
    </div>
  );
}
