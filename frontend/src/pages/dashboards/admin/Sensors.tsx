import { type FormEvent, useState } from "react";
import { ActionFeedback, Button, Card, Empty, Field, inputClass } from "../../../components/ui";
import { api } from "../../../lib/api";
import { shortAddress } from "../../../lib/format";
import { useAction, useApi } from "../../../lib/hooks";

type Sensor = { sensor_id: string; label: string; device: string; registered_at: string };

export function Sensors() {
  const { data, reload } = useApi<Sensor[]>("oracle", "/sensors");
  const [sensorId, setSensorId] = useState("");
  const [label, setLabel] = useState("");
  const add = useAction();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    add.run(async () => {
      await api("oracle", "/sensors", { body: { sensorId, label } });
      setSensorId("");
      setLabel("");
      await reload();
    }, "Sensor registered on-chain.");
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Register a sensor" subtitle="Only registered sensors can commit evidence." className="lg:col-span-1">
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Sensor ID" hint="Up to 31 characters, e.g. SENS-CTR-02">
            <input className={inputClass} value={sensorId} onChange={(e) => setSensorId(e.target.value)} required maxLength={31} />
          </Field>
          <Field label="Label">
            <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Reefer container logger" required />
          </Field>
          <ActionFeedback error={add.error} success={add.success} />
          <Button type="submit" busy={add.busy} className="w-full">
            Register sensor
          </Button>
        </form>
      </Card>
      <Card title="Registered sensors" className="lg:col-span-2">
        {!data?.length ? (
          <Empty>No sensors registered yet.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {data.map((s) => (
              <li key={s.sensor_id} className="flex items-center justify-between py-3">
                <span>
                  <span className="font-mono font-medium">{s.sensor_id}</span>
                  <span className="text-muted"> · {s.label}</span>
                </span>
                <span className="font-mono text-xs text-muted" title="Simulated device key that signs this sensor's commits">
                  device {shortAddress(s.device)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
