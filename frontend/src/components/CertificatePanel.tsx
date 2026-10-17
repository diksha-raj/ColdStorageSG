// A batch's quality record: the verdict for each of its five stages, the claims QA has to rule on,
// QA's final release/reject decision, and the buyer's acknowledgement that closes the batch.
import { BadgeCheck, ChevronRight, PackageCheck, PackageX, Printer, ShieldAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { sendTx } from "../lib/chain";
import { HANDOVER_NAMES, LEG_NAMES, REASON_LABELS, formatTime, sameAddress } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { BatchCertificate } from "../lib/types";
import { ActionFeedback, Badge, Button, Card, Field, Loading, Party, StatusBadge, inputClass } from "./ui";

/** Where a batch is in its lifecycle, as one word for badges. */
export function certificateState(c?: BatchCertificate | null) {
  if (!c) return "awaiting";
  if (c.acknowledgement) return "acknowledged";
  if (c.decision) return c.decision.disposition; // released / rejected
  return c.certificate?.status ?? (c.stages?.some((s) => s.reasons.length) ? "flagged" : "awaiting");
}

export function CertificatePanel({ batchId, buyer, inspector }: { batchId: number; buyer?: string; inspector?: string }) {
  const { session } = useAuth();
  const { data, loading, reload } = useApi<BatchCertificate>("certificate", `/certificates/${batchId}`, 5000);
  const ack = useAction();

  if (loading && !data) return <Loading />;
  if (!data) return null;

  const openClaims = data.claims.filter((c) => c.status === "open").length;
  const isBuyer = sameAddress(session?.wallet, buyer);
  const isInspector = sameAddress(session?.wallet, inspector);
  const canDecide = isInspector && !!data.certificate && openClaims === 0 && !data.decision;
  const canAcknowledge = isBuyer && !!data.decision && !data.acknowledgement;

  // What's still holding the certificate up: a handover not signed in yet, or a stage whose sensor
  // readings haven't been committed and verified yet (a few seconds after the handover).
  const missing = data.certificate
    ? []
    : data.stages.flatMap((st) =>
        !st.checkpointDone
          ? [`the ${HANDOVER_NAMES[st.stage]} handover`]
          : !st.sensorDone
            ? [`the ${LEG_NAMES[st.stage]} sensor readings`]
            : [],
      );

  return (
    <Card
      title="Quality certificate"
      subtitle={
        data.certificate
          ? `Issued ${formatTime(data.certificate.issuedAt)}`
          : missing.length
            ? `Not issued yet. Waiting for ${missing.join(", ")}.`
            : "Every stage is in: the certificate is being issued."
      }
      action={
        <div className="flex items-center gap-2">
          {data.certificate ? (
            <Link
              to={`/certificates/${batchId}/print`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-canvas"
            >
              <Printer className="size-4" aria-hidden /> Printable certificate
            </Link>
          ) : (
            <span
              aria-disabled="true"
              title="Available once the certificate is issued"
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-muted opacity-60"
            >
              <Printer className="size-4" aria-hidden /> Printable certificate
            </span>
          )}
          <StatusBadge status={certificateState(data)} />
        </div>
      }
    >
      <ol className="grid gap-3 sm:grid-cols-5">
        {data.stages.map((st) => {
          const lp = data.legPasses.find((p) => p.leg === st.stage);
          const status = st.reasons.length ? "flagged" : lp && !lp.pending ? "pass" : "awaiting";
          return (
            <li key={st.stage} className={`rounded-xl border p-3 ${st.reasons.length ? "border-fail/30" : "border-line"}`}>
              <div className="text-xs font-medium uppercase tracking-wide text-muted">Stage {st.stage}</div>
              <div className="mt-0.5 text-sm font-medium">{LEG_NAMES[st.stage]}</div>
              <div className="mt-2">
                <StatusBadge status={status} />
              </div>
              {st.reasons.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-fail">
                  {st.reasons.map((r) => (
                    <li key={r}>{REASON_LABELS[r]}</li>
                  ))}
                </ul>
              )}
              {lp && !lp.pending && (
                <div className="mt-2 text-xs text-muted tabular-nums">
                  Sensor peak {lp.maxTempC.toFixed(1)} °C · received at {lp.receiptTempC.toFixed(1)} °C
                  {lp.gapMinutes > 0 && ` · ${lp.gapMinutes} min on the dock`}
                </div>
              )}
              {!st.checkpointDone && <div className="mt-2 text-xs text-muted">Handover not done yet</div>}
              {st.checkpointDone && !st.sensorDone && <div className="mt-2 text-xs text-muted">Sensor readings being verified</div>}
            </li>
          );
        })}
      </ol>

      {data.claims.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold">Flagged stages for QA</h3>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {[...data.claims]
              .sort((a, b) => a.leg - b.leg)
              .map((c) => (
                <li key={c.id}>
                  <Link to={`/claims/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-canvas">
                    <span className="flex items-center gap-3">
                      <ShieldAlert className="size-4 shrink-0 text-warn" aria-hidden />
                      <span>
                        Stage {c.leg} ({LEG_NAMES[c.leg]}) · <span className="text-muted">held by </span>
                        <Party wallet={c.provisionalCustodian} inline />
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={c.resolution?.outcome ?? c.status} />
                      <ChevronRight className="size-4 text-muted" aria-hidden />
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* QA's final decision */}
      <div className="mt-5 border-t border-line pt-4">
        {data.decision ? (
          <div className={`flex items-start gap-3 rounded-xl px-4 py-3 ${data.decision.disposition === "released" ? "bg-pass-soft text-pass" : "bg-fail-soft text-fail"}`}>
            {data.decision.disposition === "released" ? <PackageCheck className="mt-0.5 size-5 shrink-0" aria-hidden /> : <PackageX className="mt-0.5 size-5 shrink-0" aria-hidden />}
            <div className="text-sm">
              <div className="font-semibold">{data.decision.disposition === "released" ? "QA released this batch for sale" : "QA rejected this batch: not to be sold"}</div>
              <div>“{data.decision.note}”</div>
              <div className="mt-1 text-xs opacity-80">
                <Party wallet={data.decision.inspector} inline /> · {formatTime(data.decision.decidedAt)}
              </div>
            </div>
          </div>
        ) : canDecide ? (
          <DispositionForm batchId={batchId} onDone={reload} />
        ) : (
          <p className="text-sm text-muted">
            {!data.certificate
              ? "QA's final decision comes after the certificate is issued."
              : openClaims > 0
                ? `QA's final decision: waiting for rulings on ${openClaims} flagged stage(s).`
                : "Waiting for QA's final decision (release for sale or reject)."}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        {data.acknowledgement ? (
          <span className="flex items-center gap-2 text-pass">
            <BadgeCheck className="size-4" aria-hidden />
            Receipt acknowledged by <Party wallet={data.acknowledgement.buyer} inline /> on {formatTime(data.acknowledgement.acknowledgedAt)}. This batch is
            closed.
          </span>
        ) : (
          <span className="text-muted">The buyer acknowledges receipt after QA's decision, which closes the batch.</span>
        )}
        {canAcknowledge && (
          <Button
            busy={ack.busy}
            onClick={() =>
              ack.run(async () => {
                await sendTx("CertificateRegistry", "acknowledgeReceipt", [batchId]);
                await reload();
              }, "Receipt acknowledged. The batch is closed.")
            }
          >
            <BadgeCheck className="size-4" aria-hidden /> Acknowledge receipt
          </Button>
        )}
      </div>
      <div className="mt-3">
        <ActionFeedback error={ack.error} success={ack.success} />
      </div>
    </Card>
  );
}

function DispositionForm({ batchId, onDone }: { batchId: number; onDone: () => void }) {
  const [disposition, setDisposition] = useState<1 | 2>(1);
  const [note, setNote] = useState("");
  const submit = useAction();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      await sendTx("CertificateRegistry", "submitDisposition", [batchId, disposition, note.trim()]);
      onDone();
    });
  };
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <h3 className="font-semibold">Your final decision on this batch</h3>
        <p className="text-sm text-muted">Every flagged stage has a ruling. Is this food fit for sale? Signed on-chain and final.</p>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Decision</legend>
        {(
          [
            [1, "Release for sale", "Safe to sell despite any recorded issues"],
            [2, "Reject", "Not to be sold (dispose or return, settled off-platform)"],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className={`cursor-pointer rounded-xl border p-3 text-sm ${disposition === value ? "border-brand bg-brand-soft" : "border-line"}`}>
            <input type="radio" name="disposition" className="sr-only" checked={disposition === value} onChange={() => setDisposition(value)} />
            <span className="font-medium">{label}</span>
            <span className="mt-0.5 block text-xs text-muted">{hint}</span>
          </label>
        ))}
      </fieldset>
      <Field label="Reason" hint="Stored on-chain with your decision (max 1000 bytes).">
        <textarea className={`${inputClass} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} required maxLength={1000} />
      </Field>
      <ActionFeedback error={submit.error} />
      <Button type="submit" busy={submit.busy} disabled={!note.trim()}>
        Sign final decision
      </Button>
      <Badge tone="neutral">One decision per batch</Badge>
    </form>
  );
}
