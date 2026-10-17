// The supplier: creates batches (each with its buyer, quality inspector, max temperature and grace
// period), covers them with its cold-room sensor, and signs each one off to Cargo.
import { Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAuth } from "../../auth";
import { certificateState } from "../../components/CertificatePanel";
import { HandoverActions } from "../../components/HandoverActions";
import { QualityLog } from "../../components/QualityLog";
import { type SensorChoice, SensorPicker, emptySensorChoice, registerSensor, sensorChoiceReady } from "../../components/SensorPicker";
import { ShipmentCard } from "../../components/ShipmentCard";
import { ActionFeedback, Button, Card, Empty, Field, Loading, Notice, PageHeader, StatusBadge, inputClass } from "../../components/ui";
import { api } from "../../lib/api";
import { sendTx } from "../../lib/chain";
import { sameAddress } from "../../lib/format";
import { useAction, useApi } from "../../lib/hooks";
import { useParticipants } from "../../lib/participants";
import type { BatchCertificate, Unit } from "../../lib/types";

export function SupplierDashboard() {
  const { session } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data: units, loading, reload } = useApi<Unit[]>("custody", "/shipments", 5000);
  const { data: certs } = useApi<BatchCertificate[]>("certificate", "/certificates", 5000);

  const mine = (units ?? []).filter((u) => u.kind === "batch" && sameAddress(u.supplier, session!.wallet)).sort((a, b) => b.id - a.id);
  const atOrigin = mine.filter((u) => u.stage === "Origin");
  const shipped = mine.filter((u) => u.stage !== "Origin");
  const certOf = (id: number) => certs?.find((c) => c.batchId === id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your batches"
        subtitle="Create batches with their temperature limits, cover them with your cold-room sensor, then sign each one off to Cargo."
        action={
          !creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New batches
            </Button>
          )
        }
      />

      {creating && (
        <NewBatchesForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      {loading && !units ? (
        <Loading />
      ) : (
        <>
          <Card title="In your cold room" subtitle="Signing a batch off records the moment it leaves you.">
            {atOrigin.length === 0 ? (
              <Empty>{creating ? "Fill in the form above." : "No batches waiting to ship. Create some to start."}</Empty>
            ) : (
              <div className="space-y-3">
                {atOrigin.map((b) => (
                  <ShipmentCard key={b.id} unit={b}>
                    <div className="space-y-3">
                      <QualityLog unitId={b.id} limitC={b.thresholdC} />
                      <HandoverActions unit={b} onDone={reload} />
                    </div>
                  </ShipmentCard>
                ))}
              </div>
            )}
          </Card>
          {shipped.length > 0 && (
            <Card title="Shipped">
              <div className="space-y-3">
                {shipped.map((b) => (
                  <ShipmentCard key={b.id} unit={b} status={<StatusBadge status={certificateState(certOf(b.id))} />} />
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---- Create batches + register the cold-room sensor -----------------------------------------

type BatchDraft = {
  buyer: string;
  inspector: string;
  product: string;
  quantity: string;
  unit: string;
  thresholdC: string;
  graceMinutes: string;
};

const blankBatch = (): BatchDraft => ({ buyer: "", inspector: "", product: "", quantity: "", unit: "kg", thresholdC: "4", graceMinutes: "15" });

function NewBatchesForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { ofRole } = useParticipants();
  const buyers = ofRole("BUYER");
  const inspectors = ofRole("INSPECTOR");
  const [batches, setBatches] = useState<BatchDraft[]>([blankBatch()]);
  const [sensor, setSensor] = useState<SensorChoice>(emptySensorChoice());
  const [step, setStep] = useState<string | null>(null);
  const submit = useAction();

  // A select shows its first option until the user picks one; use that same value on submit.
  const pick = <T,>(value: string, options: T[], key: (o: T) => string) => value || (options[0] ? key(options[0]) : "");
  const update = (i: number, patch: Partial<BatchDraft>) => setBatches((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const total = batches.length + 1;
    submit.run(async () => {
      const ids: number[] = [];
      for (const [i, b] of batches.entries()) {
        setStep(`Step ${i + 1} of ${total}: confirm batch ${i + 1} in MetaMask`);
        const created = await sendTx("ShipmentCustody", "createBatch", [
          pick(b.buyer, buyers, (o) => o.wallet),
          pick(b.inspector, inspectors, (o) => o.wallet),
          Math.round(Number(b.thresholdC) * 10),
          Number(b.graceMinutes),
        ]);
        await api("custody", "/batches", { body: { txHash: created.hash, product: b.product, quantity: Number(b.quantity), unit: b.unit } });
        ids.push(Number(created.events.find((ev) => ev.name === "BatchCreated")!.args.batchId));
      }
      setStep(`Step ${total} of ${total}: confirm your sensor in MetaMask`);
      await registerSensor(ids, sensor);
      setStep(null);
      onCreated();
    });
  };

  const missing = buyers.length === 0 ? "No buyers are registered yet." : inspectors.length === 0 ? "No quality inspectors are registered yet." : null;

  return (
    <Card
      title="New batches"
      subtitle="Each batch's limits are fixed on-chain once created. You'll confirm one transaction per batch, then one for your sensor."
      action={
        <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-canvas" aria-label="Close">
          <X className="size-4" />
        </button>
      }
    >
      {missing && (
        <div className="mb-4">
          <Notice tone="error">{missing}</Notice>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-6">
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
              <div className="grid grid-cols-2 gap-2">
                <Field label="Max °C">
                  <input className={inputClass} type="number" step="0.1" min="-30" max="25" value={b.thresholdC} onChange={(e) => update(i, { thresholdC: e.target.value })} required />
                </Field>
                <Field label="Grace (min)">
                  <input className={inputClass} type="number" min="0" max="240" value={b.graceMinutes} onChange={(e) => update(i, { graceMinutes: e.target.value })} required />
                </Field>
              </div>
              <Field label="Buyer">
                <select className={inputClass} value={pick(b.buyer, buyers, (o) => o.wallet)} onChange={(e) => update(i, { buyer: e.target.value })}>
                  {buyers.map((p) => (
                    <option key={p.wallet} value={p.wallet}>
                      {p.org_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Quality Inspector">
                <select className={inputClass} value={pick(b.inspector, inspectors, (o) => o.wallet)} onChange={(e) => update(i, { inspector: e.target.value })}>
                  {inspectors.map((p) => (
                    <option key={p.wallet} value={p.wallet}>
                      {p.org_name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {batches.length > 1 && (
              <Button type="button" variant="ghost" className="mt-3" onClick={() => setBatches((bs) => bs.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" aria-hidden /> Remove batch
              </Button>
            )}
          </fieldset>
        ))}

        <Button type="button" variant="secondary" onClick={() => setBatches((bs) => [...bs, blankBatch()])}>
          <Plus className="size-4" aria-hidden /> Add another batch
        </Button>

        <div className="rounded-xl border border-line p-4">
          <div className="mb-2 text-sm font-semibold">Your cold-room sensor</div>
          <p className="mb-3 text-sm text-muted">It covers these batches from now until you sign each one off to Cargo.</p>
          <SensorPicker value={sensor} onChange={setSensor} label="Cold-room sensor" />
        </div>

        <div className="flex justify-end">
          <Button type="submit" busy={submit.busy} disabled={!!missing || !sensorChoiceReady(sensor)}>
            Create batches
          </Button>
        </div>
        {submit.busy && step && <Notice tone="info">{step}</Notice>}
        <ActionFeedback error={submit.error} />
      </form>
    </Card>
  );
}
