// A batch's sensor evidence, stage by stage: who held it and when (entry to exit), whose sensor
// covered it, what the readings show against the batch's limit, the handover gap that followed,
// and a one-click check that the stored readings still match what the sensor committed on-chain.
import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { readContract, sha256Hex } from "../lib/chain";
import { LEG_NAMES, SENSOR_MODES, SENSOR_OF_STAGE, formatTime, shortHash } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { Evidence, StageEvidence } from "../lib/types";
import { EvidenceChart } from "./EvidenceChart";
import { ActionFeedback, Badge, Button, Card, Loading, Party, StatusBadge } from "./ui";

export function LegEvidence({ batchId, onlyLeg }: { batchId: number; onlyLeg?: number }) {
  const { data, loading } = useApi<Evidence>("oracle", `/evidence/${batchId}`, 5000);
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const stages = onlyLeg === undefined ? data.stages : data.stages.filter((s) => s.stage === onlyLeg);
  return (
    <Card
      title={onlyLeg === undefined ? "Temperature, supplier to buyer" : `Stage ${onlyLeg} · ${LEG_NAMES[onlyLeg]} temperature`}
      subtitle={`Limit ${data.thresholdC} °C, ${data.graceMinutes} min grace. Each stage is covered by its holder's own sensor.`}
    >
      <EvidenceChart stages={stages} thresholdC={data.thresholdC} />
      <div className="mt-5 divide-y divide-line">
        {stages.map((s) => (
          <StageRow key={s.stage} batchId={batchId} s={s} thresholdC={data.thresholdC} graceMinutes={data.graceMinutes} />
        ))}
      </div>
    </Card>
  );
}

function StageRow({ batchId, s, thresholdC, graceMinutes }: { batchId: number; s: StageEvidence; thresholdC: number; graceMinutes: number }) {
  const status = s.summary?.status ?? (s.start && !s.end ? "live" : "awaiting");
  return (
    <section className="py-4" aria-label={`Stage ${s.stage} evidence`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-medium">
            {s.stage}. {LEG_NAMES[s.stage]}
          </h4>
          <p className="text-sm text-muted">
            {s.start ? `${formatTime(s.start)} → ${s.end ? formatTime(s.end) : "now"}` : "Not reached yet"}
            {s.custodian && (
              <>
                {" · held by "}
                <Party wallet={s.custodian} inline />
              </>
            )}
          </p>
        </div>
        <StatusBadge status={status} />
      </div>

      <p className="mt-2 text-sm">
        {s.sensor ? (
          <>
            <span className="text-muted">{SENSOR_OF_STAGE[s.stage].owner}'s {SENSOR_OF_STAGE[s.stage].what}: </span>
            <span className="font-mono">{s.sensor.sensorId}</span> {s.sensor.mode && <Badge tone="neutral">{SENSOR_MODES[s.sensor.mode]}</Badge>}
          </>
        ) : (
          <span className="text-muted">No sensor registered for this stage yet.</span>
        )}
      </p>

      {s.summary && s.readings.length === 0 && (
        <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          The sensor sent no readings for this stage: {s.summary.missingMinutes} min without data.
        </p>
      )}
      {s.summary && s.readings.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="Peak" value={`${s.summary.maxC.toFixed(1)} °C`} alert={s.summary.maxC > thresholdC} />
          <Metric label="Longest above limit" value={`${s.summary.breachMinutes} min`} alert={s.summary.breachMinutes > graceMinutes} />
          <Metric label="No readings" value={`${s.summary.missingMinutes} min`} alert={s.summary.missingMinutes > graceMinutes} />
          <Metric label="Lowest" value={`${s.summary.minC.toFixed(1)} °C`} />
        </dl>
      )}

      {s.gap && (
        <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${s.gap.minutes > graceMinutes ? "bg-warn-soft text-warn" : "bg-canvas text-muted"}`}>
          Handover to the next holder: <strong>{s.gap.minutes} min</strong> on the dock with no sensor ({formatTime(s.gap.from)} sign-off →{" "}
          {formatTime(s.gap.to)} sign-in){s.gap.minutes > graceMinutes && `, longer than the ${graceMinutes}-minute grace period`}.
        </p>
      )}

      {s.summary?.status === "EvidenceMismatch" && (
        <p className="mt-3 rounded-lg border border-fail/20 bg-fail-soft px-3 py-2 text-sm text-fail">
          The stored readings don't match the hash the sensor committed: they were altered after the sensor reported. No certificate can be
          issued for this stage until the genuine readings are restored.
        </p>
      )}

      {s.committed && s.recordedOn && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted">
            Sensor committed <span className="font-mono">{shortHash(s.committed.fileHash)}</span>
          </span>
          <VerifyReadings batchId={batchId} stage={s.stage} unit={s.recordedOn} />
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-lg bg-canvas px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-semibold tabular-nums ${alert ? "text-fail" : ""}`}>{value}</dd>
    </div>
  );
}

/** Fetches the stored readings file, hashes it in the browser, and asks the contract whether it matches. */
function VerifyReadings({ batchId, stage, unit }: { batchId: number; stage: number; unit: number }) {
  const verify = useAction();
  const [result, setResult] = useState<{ hash: string; matches: boolean } | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        busy={verify.busy}
        onClick={() =>
          verify.run(async () => {
            const log = await api<{ csv: string }>("gateway", `/logs/${unit}/${stage}`);
            const hash = await sha256Hex(new TextEncoder().encode(log.csv).buffer as ArrayBuffer);
            const oracle = await readContract("SensorOracle");
            setResult({ hash, matches: await oracle.verifyFileHash(batchId, stage, hash) });
          })
        }
      >
        <Fingerprint className="size-4" aria-hidden /> Verify readings on-chain
      </Button>
      {result && (
        <span className={result.matches ? "text-pass" : "text-fail"}>
          {result.matches
            ? `The stored readings match the sensor's on-chain commit (${shortHash(result.hash)}).`
            : `The stored readings do NOT match the sensor's on-chain commit (${shortHash(result.hash)}).`}
        </span>
      )}
      <ActionFeedback error={verify.error} />
    </>
  );
}
