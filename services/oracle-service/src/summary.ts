// Turning a sensor's committed readings into one batch's summary for one stage.
import { createHash } from "node:crypto";

export type Reading = { at: number; tempC: number }; // at = unix seconds

export type StageStats = {
  minC: number;
  maxC: number;
  breachMinutes: number; // longest continuous run above the limit
  breachStart: number; // unix seconds, 0 if never above the limit
  breachEnd: number;
  missingMinutes: number; // time in the window with no readings
};

/** SHA-256 of the file's exact bytes, as a 0x-prefixed bytes32. */
export const sha256 = (file: string | Buffer) => "0x" + createHash("sha256").update(file).digest("hex");

/** Parses the gateway's `timestamp,temperature_c` file. */
export function parseCsv(csv: string): Reading[] {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((row, i) => {
      const [timestamp, temp] = row.split(",");
      const ms = Date.parse(timestamp);
      const tempC = Number(temp);
      if (Number.isNaN(ms) || Number.isNaN(tempC)) throw new Error(`Bad row ${i + 2}: "${row}"`);
      return { at: ms / 1000, tempC };
    });
}

/**
 * Summarises the readings inside [start, end] (unix seconds) against `thresholdC`. Durations are
 * real minutes.
 *
 * - The longest excursion runs from the first reading above the limit to the first reading back
 *   within it (or to the last reading, if it never came back).
 * - Missing minutes add up every stretch longer than one reading interval with no reading,
 *   including before the first reading and after the last. The interval is the sensor's own
 *   (the tightest spacing of its readings), defaulting to a minute.
 */
export function summarize(all: Reading[], thresholdC: number, start: number, end: number): StageStats {
  const readings = all.filter((r) => r.at >= start && r.at <= end);
  const toMinutes = (seconds: number) => Math.round(seconds / 60);
  const interval = typicalInterval(all);

  let missing = 0;
  const times = [start, ...readings.map((r) => r.at), end];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > interval * 1.5) missing += gap - interval;
  }

  if (readings.length === 0) {
    return { minC: 0, maxC: 0, breachMinutes: 0, breachStart: 0, breachEnd: 0, missingMinutes: toMinutes(end - start) };
  }

  let best = { start: 0, end: 0 };
  let runStart: number | null = null;
  readings.forEach((r, i) => {
    if (r.tempC > thresholdC) {
      runStart ??= r.at;
    } else if (runStart !== null) {
      if (r.at - runStart > best.end - best.start) best = { start: runStart, end: r.at };
      runStart = null;
    }
    if (i === readings.length - 1 && runStart !== null && r.at - runStart > best.end - best.start) {
      best = { start: runStart, end: r.at };
    }
  });

  const temps = readings.map((r) => r.tempC);
  return {
    minC: Math.min(...temps),
    maxC: Math.max(...temps),
    breachMinutes: toMinutes(best.end - best.start),
    breachStart: Math.floor(best.start),
    breachEnd: Math.ceil(best.end),
    missingMinutes: toMinutes(missing),
  };
}

/** The sensor's reading interval: the tightest spacing between its readings, in seconds; a minute if unknown. */
function typicalInterval(readings: Reading[]) {
  const gaps = readings.slice(1).map((r, i) => r.at - readings[i].at).filter((g) => g > 0);
  return gaps.length ? Math.min(...gaps) : 60;
}
