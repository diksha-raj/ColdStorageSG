// Cargo, the destination freight handler, the cold store and the reefer truck share one dashboard:
// sign in what's handed to you, cover what you hold with your own sensor, and sign it off to the
// next party. Cargo also opens containers; the cold store unloads them. What you've handed on stays
// listed, with your stage's verdict and any claim against it.
import { hexlify, toUtf8Bytes } from "ethers";
import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAuth } from "../../auth";
import { HandoverActions } from "../../components/HandoverActions";
import { QualityLog } from "../../components/QualityLog";
import { type SensorChoice, SensorPicker, emptySensorChoice, registerSensor, sensorChoiceReady } from "../../components/SensorPicker";
import { ShipmentCard } from "../../components/ShipmentCard";
import { ActionFeedback, Button, Card, Empty, Field, Loading, Notice, PageHeader, StatusBadge, inputClass } from "../../components/ui";
import { api } from "../../lib/api";
import { sendTx } from "../../lib/chain";
import { LEG_NAMES, REASON_LABELS, ROLE_LABELS, type Role, containerNumberProblem, sameAddress } from "../../lib/format";
import { useAction, useApi } from "../../lib/hooks";
import type { BatchCertificate, Unit } from "../../lib/types";

const INTRO: Partial<Record<Role, string>> = {
  CARRIER: "Open a container and register its sensor, receive the supplier's batches into it, then seal it and hand it to the destination freight handler.",
  HANDLER: "Sign in sealed containers on arrival, log what happens on the ground, then hand them to the cold store. The container's own sensor keeps reading.",
  COLD_STORE: "Sign in containers, cover their batches with your cold-room sensor, unload them, and sign each batch off to a reefer truck.",
  TRUCK: "Sign in batches at pickup, register your truck's sensor, log temperatures on the road, and deliver each one to its buyer.",
};

/** The stage each custodian role holds a batch for. */
const MY_STAGE: Partial<Record<Role, number>> = { CARRIER: 1, HANDLER: 2, COLD_STORE: 3, TRUCK: 4 };

export function CustodianDashboard({ role }: { role: Role }) {
  const { session } = useAuth();
  const { data: units, loading, reload } = useApi<Unit[]>("custody", "/shipments", 4000);
  const { data: certs } = useApi<BatchCertificate[]>("certificate", "/certificates", 8000);
  const [opening, setOpening] = useState(false);
  const me = session!.wallet;

  const incoming = (units ?? []).filter((u) => sameAddress(u.pendingTo, me));
  // Batches inside a container are shown within it; unloaded containers are done.
  const holding = (units ?? []).filter((u) => sameAddress(u.custodian, me) && !u.unloadedAt && !u.inContainer && u.stage !== "Delivered");
  const inside = (containerId: number) => (units ?? []).filter((u) => u.kind === "batch" && u.containerId === containerId);

  // Everything you held and have handed on (or unloaded). Batches you carried inside a container are
  // shown within it; batches you handled singly (the cold store's, the truck's) on their own.
  const current = new Set([...incoming, ...holding].map((u) => u.id));
  const handled = (units ?? [])
    .filter((u) => u.holders.some((h) => sameAddress(h, me)) && !current.has(u.id) && !(u.kind === "batch" && u.inContainer))
    .sort((a, b) => b.id - a.id);
  const handledContainers = new Set(handled.filter((u) => u.kind === "container").map((u) => u.id));
  const shownInContainer = (u: Unit) => u.kind === "batch" && !!u.containerId && handledContainers.has(u.containerId) && role !== "COLD_STORE" && role !== "TRUCK";
  const myStage = MY_STAGE[role];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${ROLE_LABELS[role]} dashboard`}
        subtitle={INTRO[role]}
        action={
          role === "CARRIER" &&
          !opening && (
            <Button onClick={() => setOpening(true)}>
              <Plus className="size-4" aria-hidden /> Open a container
            </Button>
          )
        }
      />
      {opening && <NewContainerForm onClose={() => setOpening(false)} onCreated={() => (setOpening(false), reload())} />}
      {loading && !units ? (
        <Loading />
      ) : (
        <>
          <Card title="Incoming handovers" subtitle="Signing in records on-chain the moment it reached you, and that you now hold it.">
            {incoming.length === 0 ? (
              <Empty>Nothing is waiting for you to sign in.</Empty>
            ) : (
              <div className="space-y-3">
                {incoming.map((u) => (
                  <ShipmentCard key={u.id} unit={u}>
                    <HandoverActions unit={u} onDone={reload} />
                  </ShipmentCard>
                ))}
              </div>
            )}
          </Card>
          <Card title="In your custody">
            {holding.length === 0 ? (
              <Empty>{role === "CARRIER" ? "No open containers. Open one to receive the supplier's batches." : "You aren't holding any shipments right now."}</Empty>
            ) : (
              <div className="space-y-3">
                {holding.map((u) => (
                  <ShipmentCard key={u.id} unit={u}>
                    <div className="space-y-3">
                      {u.kind === "container" && inside(u.id).length > 0 && (
                        <div className="space-y-2">
                          {inside(u.id).map((b) => (
                            <ShipmentCard key={b.id} unit={b} />
                          ))}
                        </div>
                      )}
                      <QualityLog unitId={u.id} limitC={u.thresholdC} />
                      <HandoverActions unit={u} onDone={reload} />
                    </div>
                  </ShipmentCard>
                ))}
              </div>
            )}
          </Card>
          <Card title="Handled by you" subtitle="Shipments you've handed on: where they are now, and how your stage was judged.">
            {handled.length === 0 ? (
              <Empty>Nothing handed on yet.</Empty>
            ) : (
              <div className="space-y-3">
                {handled
                  .filter((u) => !shownInContainer(u))
                  .map((u) => (
                    <ShipmentCard key={u.id} unit={u} status={u.kind === "batch" ? <YourStage batchId={u.id} stage={myStage} certs={certs} /> : undefined}>
                      {u.kind === "container" && role !== "COLD_STORE" && inside(u.id).length > 0 && (
                        <div className="space-y-2">
                          {inside(u.id).map((b) => (
                            <ShipmentCard key={b.id} unit={b} status={<YourStage batchId={b.id} stage={myStage} certs={certs} />} />
                          ))}
                        </div>
                      )}
                    </ShipmentCard>
                  ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/** Your stage's verdict on a batch, and QA's ruling if it was flagged. */
function YourStage({ batchId, stage, certs }: { batchId: number; stage?: number; certs: BatchCertificate[] | null }) {
  const cert = certs?.find((c) => c.batchId === batchId);
  const st = stage === undefined ? undefined : cert?.stages.find((x) => x.stage === stage);
  if (!st) return null;
  const claim = cert!.claims.find((c) => c.leg === stage);
  const label = `Your stage (${LEG_NAMES[stage!]})`;
  if (!st.checkpointDone || !st.sensorDone) {
    return <span className="text-xs text-muted">{label}: {st.checkpointDone ? "readings being verified" : "not handed over yet"}</span>;
  }
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5 text-xs">
      <span className="text-muted">{label}:</span>
      <StatusBadge status={st.reasons.length ? "flagged" : "pass"} />
      {st.reasons.length > 0 && <span className="text-fail">{st.reasons.map((r) => REASON_LABELS[r]).join("; ")}</span>}
      {claim && <StatusBadge status={claim.resolution?.outcome ?? "open"} />}
    </span>
  );
}

// ---- Cargo: open a container and register its sensor --------------------------------------------

function NewContainerForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  // Optional: the number painted on the physical container. Left blank, the contract generates one.
  const [containerNumber, setContainerNumber] = useState("");
  const numberProblem = containerNumber ? containerNumberProblem(containerNumber) : null;
  const [mode, setMode] = useState<"air" | "sea">("sea");
  const [voyage, setVoyage] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("Singapore");
  const [departureDate, setDepartureDate] = useState(new Date().toLocaleDateString("en-CA")); // local YYYY-MM-DD, not UTC
  const [sensor, setSensor] = useState<SensorChoice>(emptySensorChoice());
  const [step, setStep] = useState<string | null>(null);
  const submit = useAction();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      setStep("Step 1 of 2: confirm the container in MetaMask");
      const created = await sendTx("ShipmentCustody", "createContainer", [containerNumber ? hexlify(toUtf8Bytes(containerNumber)) : "0x" + "00".repeat(11)]);
      const containerId = Number(created.events.find((ev) => ev.name === "ContainerCreated")!.args.containerId);
      await api("custody", "/containers", { body: { txHash: created.hash, mode, voyage, origin, destination, departureDate } });
      setStep("Step 2 of 2: confirm the container's sensor in MetaMask");
      await registerSensor([containerId], sensor);
      setStep(null);
      onCreated();
    });
  };

  return (
    <Card
      title="Open a container"
      subtitle="By air or sea. You'll confirm one transaction for the container and one for its sensor."
      action={
        <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-canvas" aria-label="Close">
          <X className="size-4" />
        </button>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Container number (optional)" hint={numberProblem ?? "ISO 6346, as on the container. Leave blank to generate one."}>
            <input
              className={`${inputClass} font-mono uppercase ${numberProblem ? "border-fail" : ""}`}
              value={containerNumber}
              onChange={(e) => setContainerNumber(e.target.value.toUpperCase().replace(/\s/g, ""))}
              placeholder="e.g. MSKU9070323"
              maxLength={11}
              aria-invalid={!!numberProblem}
            />
          </Field>
          <Field label="Mode">
            <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as "air" | "sea")}>
              <option value="sea">Sea (reefer container)</option>
              <option value="air">Air (temperature-controlled unit)</option>
            </select>
          </Field>
          <Field label={mode === "sea" ? "Vessel / voyage" : "Flight"}>
            <input className={inputClass} value={voyage} onChange={(e) => setVoyage(e.target.value)} placeholder={mode === "sea" ? "e.g. MSC AURORA 041E" : "e.g. SQ 238"} required minLength={2} />
          </Field>
          <Field label="Origin">
            <input className={inputClass} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="e.g. Melbourne, AU" required minLength={2} />
          </Field>
          <Field label="Destination">
            <input className={inputClass} value={destination} onChange={(e) => setDestination(e.target.value)} required minLength={2} />
          </Field>
          <Field label="Departure date">
            <input className={inputClass} type="date" value={departureDate} onChange={(e) => setDepartureDate(e.target.value)} required />
          </Field>
        </div>
        <div className="rounded-xl border border-line p-4">
          <div className="mb-2 text-sm font-semibold">The container's sensor</div>
          <p className="mb-3 text-sm text-muted">
            It covers every batch you receive into this container, until the destination freight handler hands it to the cold store.
          </p>
          <SensorPicker value={sensor} onChange={setSensor} label="Container sensor" />
        </div>
        <div className="flex justify-end">
          <Button type="submit" busy={submit.busy} disabled={!!numberProblem || !sensorChoiceReady(sensor)}>
            Open container
          </Button>
        </div>
        {submit.busy && step && <Notice tone="info">{step}</Notice>}
        <ActionFeedback error={submit.error} />
      </form>
    </Card>
  );
}
