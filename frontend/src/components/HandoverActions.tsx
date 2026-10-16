// The custody actions for one container or batch, from the signed-in wallet's point of view.
// Every handover is a two-sided quality checkpoint:
//   sender    → "Check & hand over": an outgoing check (dispatch temperature, time unrefrigerated, condition)
//   receiver  → "Inspect & accept": an incoming check of what they actually received
// Both are signed on-chain inside the handover transaction. There's no rejection: problems are
// recorded, flag the stage, and are ruled on by QA. At the cold store there's also "Split".
// A handover that ends a sensor leg asks for that leg's sensor log first: upload the log, then hand over.
import { encodeBytes32String } from "ethers";
import { ArrowRight, ClipboardCheck, Split } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAuth } from "../auth";
import { api } from "../lib/api";
import { sendTx } from "../lib/chain";
import { HANDOVER_NAMES, ISSUE_CATEGORIES, LEG_NAMES, NEXT_ROLE, REASON_LABELS, ROLE_LABELS, sameAddress } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import { useParticipants } from "../lib/participants";
import { checkpointReasons, toCheckInput } from "../lib/quality";
import type { Check, LegLog, LegStatus, ShipmentDetail, Unit } from "../lib/types";
import { type LogChoice, LogPicker, emptyLogChoice, logChoiceReady, uploadLog } from "./LogPicker";
import { ActionFeedback, Badge, Button, Field, Notice, Party, inputClass } from "./ui";

const STAGE_INDEX = ["Origin", "Carrier", "Handler", "ColdStore", "Truck", "Delivered"];

export function HandoverActions({ unit, onDone }: { unit: Unit; onDone: () => void }) {
  const { session } = useAuth();
  const me = session!.wallet;
  const split = useAction();
  const [open, setOpen] = useState(false);

  // 1. Someone is handing this to me: inspect it and record what I received.
  if (sameAddress(unit.pendingTo, me)) {
    return open ? (
      <IncomingCheckForm unit={unit} onCancel={() => setOpen(false)} onDone={onDone} />
    ) : (
      <Button onClick={() => setOpen(true)}>
        <ClipboardCheck className="size-4" aria-hidden /> {unit.stage === "Truck" ? "Inspect & accept delivery" : "Inspect & accept"}
      </Button>
    );
  }

  if (!sameAddress(unit.custodian, me)) return null;

  // 2. Container at the cold store: the split ends leg 3, so upload its sensor log, then split.
  if (unit.kind === "container" && unit.stage === "ColdStore" && !unit.splitAt) {
    return <SplitWithLog unit={unit} action={split} onDone={onDone} />;
  }

  // 3. I hold it: run my outgoing check and hand over to the next custodian.
  const nextRole = NEXT_ROLE[unit.stage];
  if (!nextRole || unit.splitAt || unit.stage === "Delivered") return null;
  return (
    <div className="space-y-2">
      {unit.pendingTo && (
        <p className="text-sm text-warn">
          Waiting for <Party wallet={unit.pendingTo} inline /> to accept. You can redo the handover below.
        </p>
      )}
      {open ? (
        <OutgoingCheckForm unit={unit} nextRole={nextRole} onCancel={() => setOpen(false)} onDone={() => (setOpen(false), onDone())} />
      ) : (
        <Button variant={unit.pendingTo ? "secondary" : "primary"} onClick={() => setOpen(true)}>
          {nextRole === "BUYER" ? "Check & deliver to buyer" : `Check & hand over to ${ROLE_LABELS[nextRole]}`}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  );
}

// ---- Shared check fields -------------------------------------------------------------------

type CheckValues = { tempC: string; unrefrigeratedMinutes: string; damaged: boolean; sealIntact: boolean; issues: boolean; note: string };

function CheckFields({
  values,
  set,
  tempLabel,
  minutesLabel,
  minutesHint,
  issuesControl,
  sealNumber,
}: {
  sealNumber?: string | null;
  values: CheckValues;
  set: (patch: Partial<CheckValues>) => void;
  tempLabel: string;
  minutesLabel: string;
  minutesHint?: string;
  issuesControl: ReactNode;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={tempLabel}>
        <input className={inputClass} type="number" step="0.1" min="-40" max="60" value={values.tempC} onChange={(e) => set({ tempC: e.target.value })} required />
      </Field>
      <Field label={minutesLabel} hint={minutesHint}>
        <input className={inputClass} type="number" min="0" max="10080" value={values.unrefrigeratedMinutes} onChange={(e) => set({ unrefrigeratedMinutes: e.target.value })} required />
      </Field>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm sm:col-span-2">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-brand" checked={values.sealIntact} onChange={(e) => set({ sealIntact: e.target.checked })} />
          Seal intact{sealNumber && <span className="text-muted">(no. <span className="font-mono">{sealNumber}</span>)</span>}
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-brand" checked={values.damaged} onChange={(e) => set({ damaged: e.target.checked })} />
          Packaging damaged
        </label>
      </div>
      <div className="sm:col-span-2">{issuesControl}</div>
      <div className="sm:col-span-2">
        <Field label="Note (optional)" hint="Kept off-chain; its fingerprint is sealed into your signed check.">
          <textarea className={`${inputClass} min-h-16`} value={values.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} />
        </Field>
      </div>
    </div>
  );
}

const asNumbers = (v: CheckValues) => ({
  tempC: Number(v.tempC),
  unrefrigeratedMinutes: Number(v.unrefrigeratedMinutes || 0),
  damaged: v.damaged,
  sealIntact: v.sealIntact,
  issues: v.issues,
});

/** The batches a check is judged against: the container's batches, or the batch itself. */
function limitsOf(detail: ShipmentDetail) {
  const batches = detail.kind === "container" ? detail.batches : [detail];
  return batches.map((b) => ({ id: b.id, label: `Batch #${b.id}${b.details?.product ? ` · ${b.details.product}` : ""}`, limitC: b.thresholdC!, grace: b.graceMinutes! }));
}

// ---- Sender: outgoing check -------------------------------------------------------------------

/** Seal numbers: letters, digits and dashes, short enough to store as a bytes32 on-chain. */
const SEAL_PATTERN = /^[A-Z0-9-]{4,31}$/;

function OutgoingCheckForm({
  unit,
  nextRole,
  onCancel,
  onDone,
}: {
  unit: Unit;
  nextRole: keyof typeof ROLE_LABELS;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { ofRole } = useParticipants();
  const { data: log } = useApi<LegLog>("custody", `/shipments/${unit.id}/log`);
  const options = nextRole === "BUYER" ? ofRole("BUYER").filter((p) => sameAddress(p.wallet, unit.buyer)) : ofRole(nextRole);
  const [to, setTo] = useState("");
  const recipient = to || options[0]?.wallet || "";
  const [values, setValues] = useState<CheckValues>({ tempC: "", unrefrigeratedMinutes: "", damaged: false, sealIntact: true, issues: false, note: "" });
  const set = (patch: Partial<CheckValues>) => setValues((v) => ({ ...v, ...patch }));
  const submit = useAction();

  // Issues you reported during the leg can't be quietly left out of your signed check.
  const reportedIssues = (log?.digest.issues ?? 0) > 0;

  // This handover ends a sensor leg (carrier: 1, handler: 2, truck: 4): upload its log first.
  const sensorLeg = sensorLegClosedBy(unit);
  const { data: myLegs } = useApi<LegStatus[]>("oracle", sensorLeg ? "/legs" : null);
  const staged = myLegs?.find((l) => l.shipmentId === unit.id && l.leg === sensorLeg)?.stagedUpload ?? null;
  const [logChoice, setLogChoice] = useState<LogChoice>(emptyLogChoice());
  const logReady = !sensorLeg || logChoiceReady(logChoice) || (!!staged && logChoice.source === "");
  const minutes = values.unrefrigeratedMinutes === "" ? String(log?.digest.unrefrigeratedMinutes ?? 0) : values.unrefrigeratedMinutes;
  const effective = { ...values, unrefrigeratedMinutes: minutes, issues: values.issues || reportedIssues };

  // The supplier's dispatch: record the seal applied after loading. It's fixed once the carrier has it.
  const needsSeal = unit.kind === "container" && unit.stage === "Origin";
  const [seal, setSeal] = useState(unit.sealNumber ?? "");
  const sealValid = !needsSeal || SEAL_PATTERN.test(seal.trim());

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      // 1. Upload the leg's sensor log. It's checked against the sensor once the receiver accepts.
      if (sensorLeg && logChoiceReady(logChoice)) await uploadLog(unit.id, sensorLeg, logChoice);
      if (needsSeal && seal.trim() !== unit.sealNumber) {
        await sendTx("ShipmentCustody", "recordSeal", [unit.id, encodeBytes32String(seal.trim())]);
      }
      // 2. Then sign the outgoing check and hand over.
      const { notesHash } = await api("custody", `/shipments/${unit.id}/seal`, { body: { direction: "out", note: values.note } });
      await sendTx("ShipmentCustody", "initiateTransfer", [unit.id, recipient, toCheckInput(asNumbers(effective), notesHash)]);
      onDone();
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-brand/30 bg-white p-4">
      <div>
        <h4 className="font-semibold">Quality check before handover</h4>
        <p className="text-sm text-muted">
          {HANDOVER_NAMES[STAGE_INDEX.indexOf(unit.stage)]}. You sign this with your wallet; the receiver will see it next to their own check.
        </p>
      </div>
      {log && (
        <p className="rounded-lg bg-canvas px-3 py-2 text-sm">
          Your leg log: <strong>{log.digest.readings}</strong> reading(s)
          {log.digest.maxTempC !== null && (
            <>
              {" "}
              · peak <strong>{log.digest.maxTempC.toFixed(1)} °C</strong>
            </>
          )}{" "}
          · <strong>{log.digest.issues}</strong> issue report(s)
          {log.digest.unrefrigeratedMinutes > 0 && (
            <>
              {" "}
              · <strong>{log.digest.unrefrigeratedMinutes} min</strong> unrefrigerated
            </>
          )}
        </p>
      )}
      {sensorLeg && (
        <div className="rounded-lg border border-line p-3">
          <div className="mb-2 text-sm font-medium">
            Leg {sensorLeg} sensor log ({LEG_NAMES[sensorLeg]})
            <span className="font-normal text-muted"> · checked against the sensor's own record once the receiver accepts</span>
          </div>
          {staged && (
            <p className="mb-2 text-sm text-pass">
              Already uploaded: <span className="font-mono">{staged.fileName}</span>. Choose another file only to replace it.
            </p>
          )}
          <LogPicker value={logChoice} onChange={setLogChoice} label={`Leg ${sensorLeg} sensor log`} />
        </div>
      )}
      {needsSeal && (
        <div className="w-full sm:w-72">
          <Field label="Seal number" hint="From the seal applied after loading. It's printed on the certificate and can't be changed after dispatch.">
            <input className={`${inputClass} font-mono uppercase`} value={seal} onChange={(e) => setSeal(e.target.value.toUpperCase())} placeholder="e.g. SGB4471203" required />
          </Field>
        </div>
      )}
      <CheckFields
        values={effective}
        set={set}
        tempLabel="Probe temperature at dispatch (°C)"
        minutesLabel="Minutes without refrigeration during your custody"
        minutesHint={reportedIssues ? "Pre-filled from your issue reports." : undefined}
        issuesControl={
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand" checked={effective.issues} disabled={reportedIssues} onChange={(e) => set({ issues: e.target.checked })} />
            Issues occurred during my leg {reportedIssues && <Badge tone="warn">from your issue reports</Badge>}
          </label>
        }
      />
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <div className="w-full sm:w-72">
          <Field label={`Hand over to (${ROLE_LABELS[nextRole]})`}>
            <select className={inputClass} value={recipient} onChange={(e) => setTo(e.target.value)}>
              {options.length === 0 && <option value="">No {ROLE_LABELS[nextRole]} registered</option>}
              {options.map((p) => (
                <option key={p.wallet} value={p.wallet}>
                  {p.org_name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button type="submit" busy={submit.busy} disabled={!recipient || values.tempC === "" || !logReady || !sealValid}>
          {sensorLeg ? "Upload log, sign check & hand over" : "Sign check & hand over"} <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ActionFeedback error={submit.error} />
    </form>
  );
}

// ---- Receiver: incoming check ---------------------------------------------------------------

function IncomingCheckForm({ unit, onCancel, onDone }: { unit: Unit; onCancel: () => void; onDone: () => void }) {
  const { data: detail } = useApi<ShipmentDetail>("custody", `/shipments/${unit.id}`);
  const [values, setValues] = useState<CheckValues>({ tempC: "", unrefrigeratedMinutes: "0", damaged: false, sealIntact: true, issues: false, note: "" });
  const set = (patch: Partial<CheckValues>) => setValues((v) => ({ ...v, ...patch }));
  const submit = useAction();

  if (!detail) return <p className="text-sm text-muted">Loading the sender's check…</p>;
  const sent = detail.pendingCheck;
  const limits = limitsOf(detail);

  // Problems already recorded upstream on this shipment (permanent; nobody downstream can clear them).
  const upstream = detail.checkpoints
    .filter((cp) => cp.outgoing && cp.incoming)
    .map((cp) => ({
      stage: cp.stage,
      reasons: [...new Set(limits.flatMap((l) => checkpointReasons(cp.outgoing!, cp.incoming!, l.limitC, l.grace)))],
    }))
    .filter((x) => x.reasons.length);

  const preview =
    sent && values.tempC !== "" ? limits.map((l) => ({ ...l, reasons: checkpointReasons(sent, asNumbers(values), l.limitC, l.grace) })) : [];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      const { notesHash } = await api("custody", `/shipments/${unit.id}/seal`, { body: { direction: "in", note: values.note } });
      await sendTx("ShipmentCustody", "acceptTransfer", [unit.id, toCheckInput(asNumbers(values), notesHash)]);
      onDone();
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-brand/30 bg-white p-4">
      <div>
        <h4 className="font-semibold">Inspect on receipt</h4>
        <p className="text-sm text-muted">
          {HANDOVER_NAMES[STAGE_INDEX.indexOf(unit.stage)]}. Record what you actually received. You take custody either way; problems are flagged
          for the buyer's QA team to rule on.
        </p>
      </div>

      {upstream.length > 0 && (
        <Notice tone="error">
          Problems were already recorded upstream on this shipment:{" "}
          {upstream.map((u) => `${HANDOVER_NAMES[u.stage]} (${u.reasons.map((r) => REASON_LABELS[r].toLowerCase()).join(", ")})`).join("; ")}.
          Record your own findings as normal.
        </Notice>
      )}

      {sent && <SenderCheck check={sent} />}

      <CheckFields
        values={values}
        set={set}
        tempLabel="Probe temperature on receipt (°C)"
        sealNumber={detail.kind === "container" ? detail.sealNumber : null}
        minutesLabel="Minutes it waited unrefrigerated at the handover"
        issuesControl={
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Decision</legend>
            {(
              [
                [false, "Accept", "Received in good order"],
                [true, "Accept with issues", "Something's wrong; QA will review it"],
              ] as const
            ).map(([issues, label, hint]) => (
              <label key={label} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${values.issues === issues ? "border-brand bg-brand-soft" : "border-line"}`}>
                <input type="radio" name="decision" className="sr-only" checked={values.issues === issues} onChange={() => set({ issues })} />
                <span className="font-medium">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </label>
            ))}
          </fieldset>
        }
      />

      {preview.length > 0 && (
        <div className="space-y-1">
          {preview.map((p) =>
            p.reasons.length ? (
              <Notice key={p.id} tone="error">
                This will flag <strong>{p.label}</strong> (limit {p.limitC} °C, grace {p.grace} min): {p.reasons.map((r) => REASON_LABELS[r]).join(", ")}.
              </Notice>
            ) : (
              <Notice key={p.id} tone="success">
                {p.label}: within limits (≤ {p.limitC} °C, ≤ {p.grace} min unrefrigerated).
              </Notice>
            ),
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button type="submit" busy={submit.busy} disabled={values.tempC === ""}>
          <ClipboardCheck className="size-4" aria-hidden /> Sign check & accept custody
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ActionFeedback error={submit.error} />
    </form>
  );
}

/** The sender's signed outgoing check, for the receiver to compare against. */
export function SenderCheck({ check }: { check: Check }) {
  const sealed = check.sealed;
  return (
    <div className="rounded-lg bg-canvas p-3 text-sm">
      <div className="mb-1 font-medium">
        Sender's check · <Party wallet={check.by} inline />
      </div>
      <CheckSummary check={check} />
      {sealed?.note && <p className="mt-1 text-muted">“{sealed.note}”</p>}
      {sealed?.readings?.length || sealed?.issues?.length ? (
        <p className="mt-1 text-xs text-muted">
          {sealed.readings?.length ?? 0} reading(s)
          {sealed.readings?.length ? `, peak ${Math.max(...sealed.readings.map((r) => r.tempC)).toFixed(1)} °C` : ""}
          {sealed.issues?.length ? ` · issues: ${sealed.issues.map((i) => ISSUE_CATEGORIES[i.category] ?? i.category).join(", ")}` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function CheckSummary({ check }: { check: Check }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
      <span>
        <strong>{check.tempC.toFixed(1)} °C</strong>
      </span>
      <span>{check.unrefrigeratedMinutes} min unrefrigerated</span>
      <span className={check.sealIntact ? "" : "font-medium text-fail"}>{check.sealIntact ? "Seal intact" : "Seal broken"}</span>
      {check.damaged && <span className="font-medium text-fail">Packaging damaged</span>}
      {check.issues && <span className="font-medium text-warn">Issues reported</span>}
    </div>
  );
}

/** The sensor leg a handover from this unit ends: carrier → handler ends leg 1, handler → cold store
 *  leg 2, truck → buyer leg 4. Leg 3 (cold store) ends at the split, handled by SplitWithLog. */
function sensorLegClosedBy(unit: Unit): number | null {
  if (unit.kind === "container" && unit.stage === "Carrier") return 1;
  if (unit.kind === "container" && unit.stage === "Handler") return 2;
  if (unit.kind === "batch" && unit.stage === "Truck") return 4;
  return null;
}

/** The cold store's leg ends at the split: upload its sensor log, then split. */
function SplitWithLog({ unit, action, onDone }: { unit: Unit; action: ReturnType<typeof useAction>; onDone: () => void }) {
  const { data: myLegs } = useApi<LegStatus[]>("oracle", "/legs");
  const staged = myLegs?.find((l) => l.shipmentId === unit.id && l.leg === 3)?.stagedUpload ?? null;
  const [choice, setChoice] = useState<LogChoice>(emptyLogChoice());
  const ready = logChoiceReady(choice) || (!!staged && choice.source === "");

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line p-3">
        <div className="mb-2 text-sm font-medium">
          Leg 3 sensor log (Cold Store)
          <span className="font-normal text-muted"> · splitting ends your leg; the log is checked against the sensor's own record</span>
        </div>
        {staged && (
          <p className="mb-2 text-sm text-pass">
            Already uploaded: <span className="font-mono">{staged.fileName}</span>. Choose another file only to replace it.
          </p>
        )}
        <LogPicker value={choice} onChange={setChoice} label="Leg 3 sensor log" />
      </div>
      <Button
        busy={action.busy}
        disabled={!ready}
        onClick={() =>
          action.run(async () => {
            if (logChoiceReady(choice)) await uploadLog(unit.id, 3, choice);
            await sendTx("ShipmentCustody", "splitContainer", [unit.id]);
            onDone();
          })
        }
      >
        <Split className="size-4" aria-hidden /> Upload log & split into batches
      </Button>
      <ActionFeedback error={action.error} />
    </div>
  );
}
