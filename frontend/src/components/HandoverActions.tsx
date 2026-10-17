// The custody actions for one batch or container, from the signed-in wallet's point of view.
//
//   Register your sensor  each holder covers what it holds with its own sensor first: the
//                          supplier's cold room, Cargo's container, the cold store's room, the truck
//   Check & hand over     the sender signs the unit off (its exit time) with a quality check
//   Inspect & accept      the receiver signs it in (its entry time) with what they found;
//                          Cargo receives batches straight into one of its open containers
//   Unload                the cold store empties the container; batches go on singly
//
// Between sign-off and sign-in the goods are on the dock, unrefrigerated: that time is the
// handover gap, and it's flagged if it runs past the batch's grace period. There's no rejection:
// problems are recorded, flag the stage, and are ruled on by QA.
import { encodeBytes32String } from "ethers";
import { ArrowRight, ClipboardCheck, PackageOpen } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAuth } from "../auth";
import { api } from "../lib/api";
import { sendTx } from "../lib/chain";
import { HANDOVER_NAMES, ISSUE_CATEGORIES, NEXT_ROLE, REASON_LABELS, ROLE_LABELS, sameAddress } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import { useParticipants } from "../lib/participants";
import { checkpointReasons, toCheckInput } from "../lib/quality";
import type { Check, LegLog, ShipmentDetail, Unit } from "../lib/types";
import { SensorRegistration } from "./SensorPicker";
import { ActionFeedback, Badge, Button, Field, Notice, Party, inputClass } from "./ui";

const STAGE_INDEX = ["Origin", "Carrier", "Handler", "ColdStore", "Truck", "Delivered"];

/** What the holder's own sensor is, by stage (the handler uses the container's). */
const SENSOR_PROMPT: Record<string, { title: string; hint: string }> = {
  Origin: { title: "Register your cold-room sensor", hint: "It covers the batch from now until you sign it off to Cargo." },
  Carrier: { title: "Register the container's sensor", hint: "It covers every batch inside, from loading until the destination freight handler signs the container in, and keeps reading while the handler holds it." },
  ColdStore: { title: "Register your cold-room sensor", hint: "It covers the batches from now until you sign each one off to a reefer truck." },
  Truck: { title: "Register your truck's sensor", hint: "It covers the batch from now until you sign it off to the buyer." },
};

export function HandoverActions({ unit, onDone }: { unit: Unit; onDone: () => void }) {
  const { session } = useAuth();
  const me = session!.wallet;
  const [open, setOpen] = useState(false);

  // 1. Someone is handing this to me: inspect it and record what I received.
  if (sameAddress(unit.pendingTo, me)) {
    return open ? (
      <IncomingCheckForm unit={unit} onCancel={() => setOpen(false)} onDone={onDone} />
    ) : (
      <Button onClick={() => setOpen(true)}>
        <ClipboardCheck className="size-4" aria-hidden />{" "}
        {unit.stage === "Origin" ? "Inspect & receive into container" : unit.stage === "Truck" ? "Inspect & accept delivery" : "Inspect & accept"}
      </Button>
    );
  }

  if (!sameAddress(unit.custodian, me) || unit.stage === "Delivered") return null;

  // 2. The container at the cold store: register the room's sensor for its batches, then unload it.
  if (unit.kind === "container" && unit.stage === "ColdStore") {
    return unit.unloadedAt ? null : <UnloadContainer unit={unit} onDone={onDone} />;
  }

  // 3. A batch inside a container moves with it: nothing to do on the batch itself.
  if (unit.kind === "batch" && unit.inContainer) return null;

  // 4. Cover what I hold with my own sensor before I can sign it off.
  if (!unit.sensorId && SENSOR_PROMPT[unit.stage] && !(unit.kind === "container" && unit.stage === "Handler")) {
    return <SensorRegistration ids={[unit.id]} {...SENSOR_PROMPT[unit.stage]} onDone={onDone} />;
  }

  // 5. Sign it off to the next holder (Cargo seals the container in the same step).
  const nextRole = NEXT_ROLE[unit.stage];
  if (!nextRole) return null;
  return (
    <div className="space-y-2">
      {unit.pendingTo && (
        <p className="text-sm text-warn">
          Waiting for <Party wallet={unit.pendingTo} inline /> to sign it in. You can redo the handover below.
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

type CheckValues = { tempC: string; damaged: boolean; sealIntact: boolean; issues: boolean; note: string };
const blankCheck = (): CheckValues => ({ tempC: "", damaged: false, sealIntact: true, issues: false, note: "" });

function CheckFields({
  values,
  set,
  tempLabel,
  issuesControl,
  sealNumber,
}: {
  values: CheckValues;
  set: (patch: Partial<CheckValues>) => void;
  tempLabel: string;
  issuesControl: ReactNode;
  sealNumber?: string | null;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={tempLabel}>
        <input className={inputClass} type="number" step="0.1" min="-40" max="60" value={values.tempC} onChange={(e) => set({ tempC: e.target.value })} required />
      </Field>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 pb-2 text-sm">
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

const asNumbers = (v: CheckValues) => ({ tempC: Number(v.tempC), damaged: v.damaged, sealIntact: v.sealIntact, issues: v.issues });

/** The batches a check is judged against: the container's batches, or the batch itself. */
function limitsOf(detail: ShipmentDetail) {
  const batches = detail.kind === "container" ? detail.batches : [detail];
  return batches.map((b) => ({ id: b.id, label: `Batch #${b.id}${b.details?.product ? ` · ${b.details.product}` : ""}`, limitC: b.thresholdC!, grace: b.graceMinutes! }));
}

// ---- Sender: sign-off --------------------------------------------------------------------------

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
  const { data: detail } = useApi<ShipmentDetail>("custody", unit.kind === "container" ? `/shipments/${unit.id}` : null);
  const options = nextRole === "BUYER" ? ofRole("BUYER").filter((p) => sameAddress(p.wallet, unit.buyer)) : ofRole(nextRole);
  const [to, setTo] = useState("");
  const recipient = to || options[0]?.wallet || "";
  const [values, setValues] = useState<CheckValues>(blankCheck());
  const set = (patch: Partial<CheckValues>) => setValues((v) => ({ ...v, ...patch }));
  const submit = useAction();

  // Issues you reported while holding it can't be quietly left out of your signed check.
  const reportedIssues = (log?.digest.issues ?? 0) > 0;
  const effective = { ...values, issues: values.issues || reportedIssues };

  // Cargo seals the container after loading; the number is fixed once the handler has it.
  const needsSeal = unit.kind === "container" && unit.stage === "Carrier";
  const [seal, setSeal] = useState(unit.sealNumber ?? "");
  const sealValid = !needsSeal || SEAL_PATTERN.test(seal.trim());
  const empty = needsSeal && detail && detail.batches.length === 0;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      if (needsSeal && seal.trim() !== unit.sealNumber) {
        await sendTx("ShipmentCustody", "recordSeal", [unit.id, encodeBytes32String(seal.trim())]);
      }
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
          {HANDOVER_NAMES[STAGE_INDEX.indexOf(unit.stage)]}. Signing records the moment it leaves you; until the receiver signs it in, the time on
          the dock counts as unrefrigerated.
        </p>
      </div>
      {log && (log.digest.readings > 0 || log.digest.issues > 0) && (
        <p className="rounded-lg bg-canvas px-3 py-2 text-sm">
          Your log: <strong>{log.digest.readings}</strong> spot reading(s)
          {log.digest.maxTempC !== null && (
            <>
              {" "}
              · peak <strong>{log.digest.maxTempC.toFixed(1)} °C</strong>
            </>
          )}{" "}
          · <strong>{log.digest.issues}</strong> issue report(s)
        </p>
      )}
      {empty && <Notice tone="info">Receive at least one batch into this container before sealing and dispatching it.</Notice>}
      {needsSeal && (
        <div className="w-full sm:w-72">
          <Field label="Seal number" hint="The seal you applied after loading. It's printed on the certificate and fixed once the handler has the container.">
            <input className={`${inputClass} font-mono uppercase`} value={seal} onChange={(e) => setSeal(e.target.value.toUpperCase())} placeholder="e.g. SGB4471203" required />
          </Field>
        </div>
      )}
      <CheckFields
        values={effective}
        set={set}
        tempLabel="Probe temperature at sign-off (°C)"
        issuesControl={
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand" checked={effective.issues} disabled={reportedIssues} onChange={(e) => set({ issues: e.target.checked })} />
            Issues occurred while I held it {reportedIssues && <Badge tone="warn">from your issue reports</Badge>}
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
        <Button type="submit" busy={submit.busy} disabled={!recipient || values.tempC === "" || !sealValid || !!empty}>
          {needsSeal ? "Seal, sign check & hand over" : "Sign check & hand over"} <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ActionFeedback error={submit.error} />
    </form>
  );
}

// ---- Receiver: sign-in -----------------------------------------------------------------------

function IncomingCheckForm({ unit, onCancel, onDone }: { unit: Unit; onCancel: () => void; onDone: () => void }) {
  const { session } = useAuth();
  const { data: detail } = useApi<ShipmentDetail>("custody", `/shipments/${unit.id}`);
  // Cargo receives a batch straight into one of its open containers.
  const intoContainer = unit.kind === "batch" && unit.stage === "Origin";
  const { data: all } = useApi<Unit[]>("custody", intoContainer ? "/shipments" : null);
  const openContainers = (all ?? []).filter(
    (u) => u.kind === "container" && u.stage === "Carrier" && sameAddress(u.custodian, session!.wallet) && !u.pendingTo && !u.sealNumber,
  );
  const [containerId, setContainerId] = useState("");
  const chosenContainer = containerId || (openContainers[0] ? String(openContainers[0].id) : "");
  const [values, setValues] = useState<CheckValues>(blankCheck());
  const set = (patch: Partial<CheckValues>) => setValues((v) => ({ ...v, ...patch }));
  const submit = useAction();

  if (!detail) return <p className="text-sm text-muted">Loading the sender's check…</p>;
  const sent = detail.pendingCheck;
  const limits = limitsOf(detail);

  // Problems already recorded upstream on this shipment (permanent; nobody downstream can clear them).
  const upstream = detail.checkpoints
    .filter((cp) => cp.outgoing && cp.incoming)
    .map((cp) => ({ stage: cp.stage, reasons: [...new Set(limits.flatMap((l) => checkpointReasons(cp.outgoing!, cp.incoming!, l.limitC)))] }))
    .filter((x) => x.reasons.length);

  const preview = sent && values.tempC !== "" ? limits.map((l) => ({ ...l, reasons: checkpointReasons(sent, asNumbers(values), l.limitC) })) : [];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      const { notesHash } = await api("custody", `/shipments/${unit.id}/seal`, { body: { direction: "in", note: values.note } });
      const check = toCheckInput(asNumbers(values), notesHash);
      if (intoContainer) await sendTx("ShipmentCustody", "acceptIntoContainer", [unit.id, Number(chosenContainer), check]);
      else await sendTx("ShipmentCustody", "acceptTransfer", [unit.id, check]);
      onDone();
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-brand/30 bg-white p-4">
      <div>
        <h4 className="font-semibold">Inspect on receipt</h4>
        <p className="text-sm text-muted">
          {HANDOVER_NAMES[STAGE_INDEX.indexOf(unit.stage)]}. Signing records the moment it reaches you. Record what you actually received: you
          take custody either way, and problems are flagged for the buyer's quality inspector.
        </p>
      </div>

      {upstream.length > 0 && (
        <Notice tone="error">
          Problems were already recorded upstream:{" "}
          {upstream.map((u) => `${HANDOVER_NAMES[u.stage]} (${u.reasons.map((r) => REASON_LABELS[r].toLowerCase()).join(", ")})`).join("; ")}.
          Record your own findings as normal.
        </Notice>
      )}

      {sent && <SenderCheck check={sent} />}

      {intoContainer && (
        <div className="w-full sm:w-80">
          <Field label="Receive into container" hint={openContainers.length ? "An open container of yours, not yet sealed." : undefined}>
            <select className={inputClass} value={chosenContainer} onChange={(e) => setContainerId(e.target.value)}>
              {openContainers.length === 0 && <option value="">No open container: open one first</option>}
              {openContainers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.containerCode}
                  {c.details?.voyage ? ` · ${c.details.voyage}` : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      <CheckFields
        values={values}
        set={set}
        tempLabel="Probe temperature on receipt (°C)"
        sealNumber={detail.kind === "container" ? detail.sealNumber : null}
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
                This will flag <strong>{p.label}</strong> (limit {p.limitC} °C): {p.reasons.map((r) => REASON_LABELS[r]).join(", ")}.
              </Notice>
            ) : (
              <Notice key={p.id} tone="success">
                {p.label}: within limits (≤ {p.limitC} °C). Dock time over {p.grace} min would still flag this handover.
              </Notice>
            ),
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button type="submit" busy={submit.busy} disabled={values.tempC === "" || (intoContainer && !chosenContainer)}>
          <ClipboardCheck className="size-4" aria-hidden /> {intoContainer ? "Sign check & receive into container" : "Sign check & accept custody"}
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
          {sealed.readings?.length ?? 0} spot reading(s)
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
      <span className={check.sealIntact ? "" : "font-medium text-fail"}>{check.sealIntact ? "Seal intact" : "Seal broken"}</span>
      {check.damaged && <span className="font-medium text-fail">Packaging damaged</span>}
      {check.issues && <span className="font-medium text-warn">Issues reported</span>}
    </div>
  );
}

// ---- Cold store: sensor for the batches, then unload ------------------------------------------

function UnloadContainer({ unit, onDone }: { unit: Unit; onDone: () => void }) {
  const { data: detail, reload } = useApi<ShipmentDetail>("custody", `/shipments/${unit.id}`);
  const action = useAction();
  if (!detail) return null;
  const uncovered = detail.batches.filter((b) => !b.sensorId).map((b) => b.id);
  return (
    <div className="space-y-3">
      {uncovered.length > 0 && (
        <SensorRegistration
          ids={uncovered}
          title="Register your cold-room sensor"
          hint={`It covers the ${uncovered.length} batch(es) in this container from their arrival until you sign each one off to a reefer truck.`}
          onDone={() => (reload(), onDone())}
        />
      )}
      <Button
        busy={action.busy}
        variant={uncovered.length ? "secondary" : "primary"}
        onClick={() => action.run(async () => (await sendTx("ShipmentCustody", "unloadContainer", [unit.id]), onDone()))}
      >
        <PackageOpen className="size-4" aria-hidden /> Unload container
      </Button>
      <ActionFeedback error={action.error} />
    </div>
  );
}
