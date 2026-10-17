// Choosing a leg's sensor log: one of the demo files, or a CSV from your computer.
import { FileUp } from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import type { UploadResult } from "../lib/types";
import { inputClass } from "./ui";

/** source: a demo file id, "computer", or "" (nothing chosen yet). */
export type LogChoice = { source: string; file: File | null };
export const emptyLogChoice = (): LogChoice => ({ source: "", file: null });
export const logChoiceReady = (c: LogChoice) => c.source !== "" && (c.source !== "computer" || !!c.file);

/** The oracle answers 202 { staged } when the leg is still open, else the checked result. */
export type UploadResponse = (UploadResult & { staged?: undefined }) | { staged: true; fileName: string; fileHash: string };

export function LogPicker({ value, onChange, label = "Sensor log" }: { value: LogChoice; onChange: (c: LogChoice) => void; label?: string }) {
  const { data: demoFiles } = useApi<{ id: string; label: string }[]>("oracle", "/demo-files");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-full sm:w-80">
        <select className={inputClass} value={value.source} onChange={(e) => onChange({ ...value, source: e.target.value })} aria-label={label}>
          <option value="">Choose this leg's sensor log…</option>
          {(demoFiles ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              Demo: {f.label}
            </option>
          ))}
          <option value="computer">Choose a CSV from my computer…</option>
        </select>
      </div>
      {value.source === "computer" && (
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted hover:bg-canvas">
          <FileUp className="size-4" aria-hidden />
          <span>{value.file ? value.file.name : "Select file"}</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onChange({ ...value, file: e.target.files?.[0] ?? null })} />
        </label>
      )}
    </div>
  );
}

/** Uploads the chosen log for a leg. Sends the file's exact bytes, so the hash is of precisely what was chosen. */
export async function uploadLog(shipmentId: number, leg: number, choice: LogChoice): Promise<UploadResponse> {
  const body =
    choice.source === "computer" ? { fileBase64: await toBase64(choice.file!), fileName: choice.file!.name } : { demoFile: choice.source };
  return api<UploadResponse>("oracle", `/legs/${shipmentId}/${leg}/upload`, { body });
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.readAsDataURL(file);
  });
}
