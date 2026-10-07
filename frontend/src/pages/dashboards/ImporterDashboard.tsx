import { encodeBytes32String } from "ethers";
import { Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAuth } from "../../auth";
import { certificateState } from "../../components/CertificatePanel";
import { HandoverActions } from "../../components/HandoverActions";
import { QualityLog } from "../../components/QualityLog";
import { ShipmentCard } from "../../components/ShipmentCard";
import { ActionFeedback, Button, Card, Empty, Field, Loading, Notice, PageHeader, StatusBadge, inputClass } from "../../components/ui";
import { api } from "../../lib/api";
import { sendTx } from "../../lib/chain";
import { sameAddress } from "../../lib/format";
import { useAction, useApi } from "../../lib/hooks";
import { useParticipants } from "../../lib/participants";
import type { BatchCertificate, Unit } from "../../lib/types";

export function ImporterDashboard() {
  const { session } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data: units, loading, reload } = useApi<Unit[]>("custody", "/shipments", 5000);
  const { data: certs } = useApi<BatchCertificate[]>("certificate", "/certificates", 5000);

  const mine = (units ?? []).filter((u) => sameAddress(u.importer, session!.wallet));
  const containers = mine.filter((u) => u.kind === "container").sort((a, b) => b.id - a.id);
  const batchesOf = (id: number) => mine.filter((u) => u.kind === "batch" && u.containerId === id);
  const certOf = (id: number) => certs?.find((c) => c.batchId === id);

  return (
    <div>
      <PageHeader
        title="Your shipments"
        subtitle="Create a container, assign each batch to a buyer and QA inspector, then check it out to the air carrier."
        action={
          !creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New container
            </Button>
          )
        }
      />

      {creating && (
        <NewContainerForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      {loading && !units ? (
        <Loading />
      ) : containers.length === 0 ? (
        !creating && <Empty>No containers yet. Create one to start tracking a shipment.</Empty>
      ) : (
        <div className="space-y-4">
          {containers.map((c) => (
            <Card key={c.id}>
              <ShipmentCard unit={c}>
                <div className="space-y-3">
                  {c.stage === "Origin" && (
                    <>
                      <QualityLog unitId={c.id} />
                      <HandoverActions unit={c} onDone={reload} />
                    </>
                  )}
                  {batchesOf(c.id).map((b) => (
                    <ShipmentCard key={b.id} unit={b} status={<StatusBadge status={certificateState(certOf(b.id))} />} />
                  ))}
                </div>
              </ShipmentCard>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Create container + batches ---------------------------------------------------------

type BatchDraft = {
  buyer: string;
  inspector: string;
  product: string;
  quantity: string;
  unit: string;
  thresholdC: string;
  graceMinutes: string;
  sensorId: string;
};

const blankBatch = (): BatchDraft => ({
  buyer: "",
  inspector: "",
  product: "",
  quantity: "",
  unit: "kg",
  thresholdC: "4",
  graceMinutes: "15",
  sensorId: "",
});

function NewContainerForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { ofRole } = useParticipants();
  const { data: sensors } = useApi<{ sensor_id: string; label: string }[]>("oracle", "/sensors");
  const buyers = ofRole("BUYER");
  const inspectors = ofRole("INSPECTOR");

  const [origin, setOrigin] = useState("");
  const [departureDate, setDepartureDate] = useState(new Date().toLocaleDateString("en-CA")) // local YYYY-MM-DD, not UTC;
  const [sensorId, setSensorId] = useState("");
  const [batches, setBatches] = useState<BatchDraft[]>([blankBatch()]);
  const [step, setStep] = useState<string | null>(null);
  const submit = useAction();

  const sensorOptions = sensors ?? [];
  // A select shows its first option until the user picks one; use that same value on submit.
  const pick = <T,>(value: string, options: T[], key: (o: T) => string) => value || (options[0] ? key(options[0]) : "");
  const update = (i: number, patch: Partial<BatchDraft>) =>
    setBatches((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const total = batches.length + 1;
    submit.run(async () => {
      // 1. The container itself (MetaMask), then its off-chain details.
      setStep(`Step 1 of ${total}: confirm the container in MetaMask`);
      const created = await sendTx("ShipmentCustody", "createContainer", [
        encodeBytes32String(pick(sensorId, sensorOptions, (o) => o.sensor_id)),
      ]);
      const containerId = Number(created.events.find((ev) => ev.name === "ContainerCreated")!.args.containerId);
      await api("custody", "/containers", { body: { txHash: created.hash, origin, departureDate } });

      // 2. Each batch (MetaMask), then its off-chain details.
      for (const [i, b] of batches.entries()) {
        setStep(`Step ${i + 2} of ${total}: confirm batch ${i + 1} in MetaMask`);
        const added = await sendTx("ShipmentCustody", "addBatch", [
          containerId,
          pick(b.buyer, buyers, (o) => o.wallet),
          pick(b.inspector, inspectors, (o) => o.wallet),
          Math.round(Number(b.thresholdC) * 10),
          Number(b.graceMinutes),
          encodeBytes32String(pick(b.sensorId, sensorOptions, (o) => o.sensor_id)),
        ]);
        await api("custody", "/batches", {
          body: { txHash: added.hash, product: b.product, quantity: Number(b.quantity), unit: b.unit },
        });
      }
      setStep(null);
      onCreated();
    });
  };

  const missing =
    buyers.length === 0 ? "No buyers are registered yet." : inspectors.length === 0 ? "No QA inspectors are registered yet." : sensorOptions.length === 0 ? "No sensors are registered yet. Ask the admin to register one." : null;

  return (
    <Card
      title="New container"
      subtitle="You'll confirm one transaction for the container and one per batch."
      action={
        <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-canvas" aria-label="Close">
          <X className="size-4" />
        </button>
      }
      className="mb-6"
    >
      {missing && (
        <div className="mb-4">
          <Notice tone="error">{missing}</Notice>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Origin">
            <input className={inputClass} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="e.g. Melbourne, AU" required minLength={2} />
          </Field>
          <Field label="Departure date">
            <input className={inputClass} type="date" value={departureDate} onChange={(e) => setDepartureDate(e.target.value)} required />
          </Field>
          <Field label="Container sensor" hint="Covers the air, airport and cold-store legs.">
            <SensorSelect value={pick(sensorId, sensorOptions, (o) => o.sensor_id)} onChange={setSensorId} sensors={sensorOptions} />
          </Field>
        </div>

        {batches.map((b, i) => (
          <fieldset key={i} className="rounded-xl border border-line p-4">
            <legend className="px-1 text-sm font-semibold">Batch {i + 1}</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Product">
                <input className={inputClass} value={b.product} onChange={(e) => update(i, { product: e.target.value })} placeholder="e.g. Chilled salmon fillets" required minLength={2} />
              </Field>
              <Field label="Quantity">
                <div className="flex gap-2">
                  <input className={inputClass} type="number" min="0.01" step="any" value={b.quantity} onChange={(e) => update(i, { quantity: e.target.value })} required />
                  <input className={`${inputClass} w-20`} value={b.unit} onChange={(e) => update(i, { unit: e.target.value })} aria-label="Unit" required />
                </div>
              </Field>
              <Field label="Batch sensor" hint="Travels with the batch on the delivery truck.">
                <SensorSelect value={pick(b.sensorId, sensorOptions, (o) => o.sensor_id)} onChange={(v) => update(i, { sensorId: v })} sensors={sensorOptions} />
              </Field>
              <Field label="Buyer">
                <select className={inputClass} value={pick(b.buyer, buyers, (o) => o.wallet)} onChange={(e) => update(i, { buyer: e.target.value })}>
                  {buyers.map((p) => (
                    <option key={p.wallet} value={p.wallet}>
                      {p.org_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="QA inspector">
                <select className={inputClass} value={pick(b.inspector, inspectors, (o) => o.wallet)} onChange={(e) => update(i, { inspector: e.target.value })}>
                  {inspectors.map((p) => (
                    <option key={p.wallet} value={p.wallet}>
                      {p.org_name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Max °C">
                  <input className={inputClass} type="number" step="0.1" min="-30" max="25" value={b.thresholdC} onChange={(e) => update(i, { thresholdC: e.target.value })} required />
                </Field>
                <Field label="Grace (min)">
                  <input className={inputClass} type="number" min="0" max="240" value={b.graceMinutes} onChange={(e) => update(i, { graceMinutes: e.target.value })} required />
                </Field>
              </div>
            </div>
            {batches.length > 1 && (
              <Button type="button" variant="ghost" className="mt-3" onClick={() => setBatches((bs) => bs.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" aria-hidden /> Remove batch
              </Button>
            )}
          </fieldset>
        ))}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={() => setBatches((bs) => [...bs, blankBatch()])}>
            <Plus className="size-4" aria-hidden /> Add another batch
          </Button>
          <Button type="submit" busy={submit.busy} disabled={!!missing}>
            Create container
          </Button>
        </div>
        {submit.busy && step && <Notice tone="info">{step}</Notice>}
        <ActionFeedback error={submit.error} />
      </form>
    </Card>
  );
}

function SensorSelect({
  value,
  onChange,
  sensors,
}: {
  value: string;
  onChange: (v: string) => void;
  sensors: { sensor_id: string; label: string }[];
}) {
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {sensors.map((s) => (
        <option key={s.sensor_id} value={s.sensor_id}>
          {s.sensor_id} · {s.label}
        </option>
      ))}
    </select>
  );
}
