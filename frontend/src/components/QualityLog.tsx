// What the current holder records during their leg: spot temperature readings and issue reports.
// Saved instantly (no MetaMask); sealed into the signed outgoing check at handover.
import { AlertTriangle, Thermometer } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { ISSUE_CATEGORIES } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { LegLog } from "../lib/types";
import { ActionFeedback, Badge, Button, Field, inputClass } from "./ui";

export function QualityLog({ unitId, limitC }: { unitId: number; limitC?: number }) {
  const { data: log, reload } = useApi<LegLog>("custody", `/shipments/${unitId}/log`);
  const [mode, setMode] = useState<"reading" | "issue" | null>(null);

  return (
    <div className="rounded-xl bg-canvas p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Your quality log for this leg</span>
        <div className="flex gap-2">
          <Button variant="secondary" className="px-3 py-1.5" onClick={() => setMode(mode === "reading" ? null : "reading")}>
            <Thermometer className="size-4" aria-hidden /> Log temperature
          </Button>
          <Button variant="secondary" className="px-3 py-1.5" onClick={() => setMode(mode === "issue" ? null : "issue")}>
            <AlertTriangle className="size-4" aria-hidden /> Report issue
          </Button>
        </div>
      </div>

      {mode === "reading" && <ReadingForm unitId={unitId} onSaved={() => (setMode(null), reload())} />}
      {mode === "issue" && <IssueForm unitId={unitId} onSaved={() => (setMode(null), reload())} />}

      {log && (log.readings.length > 0 || log.issues.length > 0) ? (
        <ul className="mt-3 space-y-1.5 text-sm">
          {log.readings.map((r, i) => (
            <li key={`r${i}`} className="flex flex-wrap items-center gap-2">
              <Thermometer className="size-3.5 text-muted" aria-hidden />
              <span className={`font-semibold tabular-nums ${limitC !== undefined && r.tempC > limitC ? "text-fail" : ""}`}>
                {r.tempC.toFixed(1)} °C
              </span>
              <span className="text-muted">{new Date(r.takenAt).toLocaleString("en-SG", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</span>
              {r.note && <span className="text-muted">· {r.note}</span>}
            </li>
          ))}
          {log.issues.map((x, i) => (
            <li key={`i${i}`} className="flex flex-wrap items-center gap-2">
              <AlertTriangle className="size-3.5 text-warn" aria-hidden />
              <Badge tone="warn">{ISSUE_CATEGORIES[x.category] ?? x.category}</Badge>
              {x.unrefrigeratedMinutes > 0 && <span className="tabular-nums">{x.unrefrigeratedMinutes} min unrefrigerated</span>}
              <span className="text-muted">· {x.description}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">
          No readings or issues yet. Anything you log is sealed into your signed check when you hand over.
        </p>
      )}
    </div>
  );
}

function ReadingForm({ unitId, onSaved }: { unitId: number; onSaved: () => void }) {
  const [tempC, setTempC] = useState("");
  const [note, setNote] = useState("");
  const save = useAction();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.run(async () => {
      await api("custody", `/shipments/${unitId}/readings`, { body: { tempC: Number(tempC), note } });
      onSaved();
    });
  };
  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="w-28">
        <Field label="Probe °C">
          <input className={inputClass} type="number" step="0.1" min="-40" max="60" value={tempC} onChange={(e) => setTempC(e.target.value)} required autoFocus />
        </Field>
      </div>
      <div className="min-w-48 flex-1">
        <Field label="Note (optional)">
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Hold 2, centre pallet" />
        </Field>
      </div>
      <Button type="submit" busy={save.busy}>
        Save reading
      </Button>
      <div className="w-full">
        <ActionFeedback error={save.error} />
      </div>
    </form>
  );
}

function IssueForm({ unitId, onSaved }: { unitId: number; onSaved: () => void }) {
  const [category, setCategory] = useState("refrigeration_failure");
  const [minutes, setMinutes] = useState("0");
  const [description, setDescription] = useState("");
  const save = useAction();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.run(async () => {
      await api("custody", `/shipments/${unitId}/issues`, {
        body: { category, unrefrigeratedMinutes: Number(minutes), description },
      });
      onSaved();
    });
  };
  return (
    <form onSubmit={onSubmit} className="mt-3 grid gap-2 sm:grid-cols-4 sm:items-end">
      <Field label="What happened">
        <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
          {Object.entries(ISSUE_CATEGORIES).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Minutes without refrigeration">
        <input className={inputClass} type="number" min="0" max="10080" value={minutes} onChange={(e) => setMinutes(e.target.value)} required />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Description">
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} maxLength={1000} placeholder="e.g. Reefer tripped during refuelling stop" />
        </Field>
      </div>
      <div className="sm:col-span-4">
        <ActionFeedback error={save.error} />
        <Button type="submit" busy={save.busy} className="mt-1">
          Save issue report
        </Button>
      </div>
    </form>
  );
}
