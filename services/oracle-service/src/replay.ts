// Sensor logs: hash the raw file, rebase its readings onto the real leg window, and summarise.
import { createHash } from "node:crypto";

export type Reading = { at: number; tempC: number }; // at = unix seconds

export type LegStats = {
  minC: number;
  maxC: number;
  breachMinutes: number; // longest continuous run above the threshold
  breachStart: number; // unix seconds, 0 if never above the threshold
  breachEnd: number;
};

/** SHA-256 of the exact file bytes, as a 0x-prefixed bytes32. */
export function sha256(file: Buffer | string): string {
  return "0x" + createHash("sha256").update(file).digest("hex");
}

/**
 * Parses `timestamp,temperature_c` rows. The simulated logger starts recording at the
 * handover, so the first reading is moved to `legStart` and the rest keep their spacing.
 */
export function parseAndRebase(csv: string, legStart: number): Reading[] {
  const rows = csv.trim().split("\n").slice(1); // skip header
  const parsed = rows.map((row, i) => {
    const [timestamp, temp] = row.split(",");
    const ms = Date.parse(timestamp);
    const tempC = Number(temp);
    if (Number.isNaN(ms) || Number.isNaN(tempC)) throw new Error(`Bad CSV row ${i + 2}: "${row}"`);
    return { ms, tempC };
  });
  if (parsed.length === 0) throw new Error("CSV has no readings");
  const first = parsed[0].ms;
  return parsed.map((r) => ({ at: legStart + Math.round((r.ms - first) / 1000), tempC: r.tempC }));
}

/** Min/max and the longest continuous excursion above `thresholdC`. */
export function summarize(readings: Reading[], thresholdC: number): LegStats {
  const temps = readings.map((r) => r.tempC);
  let best = { start: 0, end: 0 };
  let runStart: number | null = null;

  readings.forEach((r, i) => {
    if (r.tempC > thresholdC) {
      runStart ??= r.at;
    } else if (runStart !== null) {
      // The excursion lasts until the first reading back within range.
      if (r.at - runStart > best.end - best.start) best = { start: runStart, end: r.at };
      runStart = null;
    }
    // Still above the threshold at the last reading: the run ends there.
    if (i === readings.length - 1 && runStart !== null && r.at - runStart > best.end - best.start) {
      best = { start: runStart, end: r.at };
    }
  });

  return {
    minC: Math.min(...temps),
    maxC: Math.max(...temps),
    breachMinutes: Math.round((best.end - best.start) / 60),
    breachStart: best.start,
    breachEnd: best.end,
  };
}

/** What a simulated sensor can record on a leg (the truth the custodian's upload is checked against). */
export const RECORDINGS = {
  compliant: "compliant.csv",
  breach: "breached.csv",
} as const;
export type Recording = keyof typeof RECORDINGS;

/** Logger files a custodian can pick in the demo instead of choosing a CSV from their computer. */
export const DEMO_FILES = {
  compliant: { file: "compliant.csv", label: "Compliant log (stays below 4 °C)" },
  breached: { file: "breached.csv", label: "Breached log (~34 min above 4 °C)" },
  tampered: { file: "tampered.csv", label: "Edited log (breach removed)" },
} as const;
export type DemoFile = keyof typeof DEMO_FILES;
