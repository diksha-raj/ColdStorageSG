// Registering the sensor that covers a shipment while you hold it: your own sensor (with its
// export, since the prototype can't reach real devices), a demo sensor that reads compliant or
// breached, or one you registered before (a cold room or truck covers many shipments).
// The sensor gateway creates the sensor's device key; you then register it on-chain from MetaMask.
import { encodeBytes32String } from "ethers";
import { FileUp, Radio } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { sendTx } from "../lib/chain";
import { SENSOR_MODES } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { GatewaySensor } from "../lib/types";
import { ActionFeedback, Button, Field, inputClass } from "./ui";

/** kind: "own", "compliant", "breached", "existing:<sensorId>", or "" (nothing chosen yet). */
export type SensorChoice = { kind: string; sensorId: string; file: File | null };
export const emptySensorChoice = (): SensorChoice => ({ kind: "", sensorId: "", file: null });
export const sensorChoiceReady = (c: SensorChoice) =>
  c.kind !== "" && (c.kind !== "own" || (/^[A-Za-z0-9-]{3,31}$/.test(c.sensorId) && !!c.file));

export function SensorPicker({ value, onChange, label = "Sensor" }: { value: SensorChoice; onChange: (c: SensorChoice) => void; label?: string }) {
  const { data: mine } = useApi<GatewaySensor[]>("gateway", "/sensors/mine");
  return (
    <div className="space-y-2">
      <div className="w-full sm:w-96">
        <select className={inputClass} value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value })} aria-label={label}>
          <option value="">Choose your sensor…</option>
          <option value="own">Register your sensor for this supply</option>
          <option value="compliant">Demo simulation: compliant sensor registration</option>
          <option value="breached">Demo simulation: breached sensor registration</option>
          {(mine ?? []).length > 0 && (
            <optgroup label="Your registered sensors">
              {mine!.map((s) => (
                <option key={s.sensorId} value={`existing:${s.sensorId}`}>
                  {s.sensorId} · {SENSOR_MODES[s.mode ?? "feed"]}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {value.kind === "own" && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full sm:w-56">
            <Field label="Sensor id" hint="As printed on the device, e.g. TT4-88213">
              <input
                className={`${inputClass} font-mono uppercase`}
                value={value.sensorId}
                onChange={(e) => onChange({ ...value, sensorId: e.target.value.toUpperCase() })}
                maxLength={31}
              />
            </Field>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted hover:bg-canvas">
            <FileUp className="size-4" aria-hidden />
            <span>{value.file ? value.file.name : "Attach its export (timestamp,temperature_c)"}</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="Sensor export" onChange={(e) => onChange({ ...value, file: e.target.files?.[0] ?? null })} />
          </label>
          <p className="w-full text-xs text-muted">
            The prototype can't connect to real devices, so the export stands in for the live feed: it's read minute by minute from now on.
          </p>
        </div>
      )}
      {value.kind === "compliant" && (
        <p className="text-xs text-muted">This demo sensor holds about 1.5 °C below the tightest temperature limit of the batches it covers.</p>
      )}
      {value.kind === "breached" && (
        <p className="text-xs text-muted">
          This demo sensor starts below the batches' limit, then its refrigeration fails a minute after you register it and climbs about 5.5 °C
          above the loosest limit it covers.
        </p>
      )}
    </div>
  );
}

/** Registers the chosen sensor with the gateway (unless reusing one), then on-chain for `ids`. */
export async function registerSensor(ids: number[], choice: SensorChoice) {
  let sensor: GatewaySensor & { device: string };
  if (choice.kind.startsWith("existing:")) {
    const mine = await api<(GatewaySensor & { device: string })[]>("gateway", "/sensors/mine");
    sensor = mine.find((s) => s.sensorId === choice.kind.slice("existing:".length))!;
  } else if (choice.kind === "own") {
    sensor = await api("gateway", "/sensors", { body: { mode: "feed", sensorId: choice.sensorId, feedCsv: await choice.file!.text() } });
  } else {
    sensor = await api("gateway", "/sensors", { body: { mode: choice.kind } });
  }
  await sendTx("ShipmentCustody", "registerSensor", [ids, encodeBytes32String(sensor.sensorId), sensor.device]);
  return sensor;
}

/** A small panel: pick a sensor and register it for these units. */
export function SensorRegistration({ ids, title, hint, onDone }: { ids: number[]; title: string; hint: string; onDone: () => void }) {
  const [choice, setChoice] = useState<SensorChoice>(emptySensorChoice());
  const action = useAction();
  return (
    <div className="space-y-3 rounded-xl border border-brand/30 bg-white p-4">
      <div>
        <h4 className="flex items-center gap-2 font-semibold">
          <Radio className="size-4 text-brand" aria-hidden /> {title}
        </h4>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      <SensorPicker value={choice} onChange={setChoice} label={title} />
      <Button busy={action.busy} disabled={!sensorChoiceReady(choice)} onClick={() => action.run(async () => (await registerSensor(ids, choice), onDone()))}>
        Register sensor
      </Button>
      <ActionFeedback error={action.error} />
    </div>
  );
}
