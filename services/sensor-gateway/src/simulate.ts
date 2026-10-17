// What a registered sensor reads at any moment. A real gateway would receive these from the
// device; here each sensor is one of three kinds, chosen when its owner registers it:
//
//   compliant  holds about 1.5 °C below the lowest limit among the batches it covers (so a
//              4 °C batch sees ~2.5 °C, a -10 °C one ~-11.5 °C), with small natural variation
//   breached   the same, until its refrigeration fails a minute after registration; it then climbs
//              over 3 minutes to about 5.5 °C above the highest limit it covers, and stays there
//   feed       the owner's own sensor: the export they attached, one reading a minute from the
//              moment they registered it (no reading once the export runs out)
//
// Simulated sensors read every 10 seconds. All times are real. Readings are deterministic (a
// function of the sensor, its profile and the time), so a window always gives the same file and hash.
import { createHash } from "node:crypto";

export type Mode = "compliant" | "breached" | "feed";
export type SimSensor = { sensorId: string; mode: Mode; registeredAt: number; feed: (number | null)[] | null };
export type Reading = { at: number; tempC: number }; // at = unix seconds
/** What the covered batches need: the sensor holds below `lowestLimitC`; a failure climbs past `highestLimitC`. */
export type Profile = { lowestLimitC: number; highestLimitC: number };

export const READING_INTERVAL_S = 10;
export const FEED_INTERVAL_S = 60;
export const BELOW_LIMIT_C = 1.5; // a healthy unit's set point, below the tightest limit
export const FAILED_ABOVE_C = 5.5; // where a failed unit settles, above the loosest limit
const FAIL_AFTER_MIN = 1;
const RAMP_MIN = 3;
/** Used only before the sensor covers any batch (e.g. an empty container's live view). */
export const DEFAULT_PROFILE: Profile = { lowestLimitC: 4, highestLimitC: 4 };

/** Small deterministic noise in [-0.5, 0.5), from the sensor id and the reading's slot. */
function noise(sensorId: string, slot: number) {
  const h = createHash("sha256").update(`${sensorId}:${slot}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000 - 0.5;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The sensor's reading at unix second `at`, or null if it has none (a feed that has run out). */
export function tempAt(sensor: SimSensor, at: number, profile: Profile): number | null {
  const minutesSinceRegistered = (at - sensor.registeredAt) / 60;
  if (sensor.mode === "feed") {
    const k = Math.floor(minutesSinceRegistered);
    return sensor.feed && k >= 0 && k < sensor.feed.length ? sensor.feed[k] : null;
  }

  const slot = Math.floor(at / READING_INTERVAL_S);
  const setPoint = profile.lowestLimitC - BELOW_LIMIT_C;
  const healthy = setPoint + 0.5 * Math.sin(at / 60 / 45) + noise(sensor.sensorId, slot) * 0.4;
  if (sensor.mode === "compliant" || minutesSinceRegistered < FAIL_AFTER_MIN) return round1(healthy);

  const failedAt = profile.highestLimitC + FAILED_ABOVE_C;
  const progress = Math.min(1, (minutesSinceRegistered - FAIL_AFTER_MIN) / RAMP_MIN);
  return round1(healthy + (failedAt - setPoint) * Math.sin((progress * Math.PI) / 2) + noise(sensor.sensorId, slot + 1) * 0.3);
}

/** Every reading the sensor took in [start, end] (unix seconds). */
export function readingsBetween(sensor: SimSensor, start: number, end: number, profile: Profile): Reading[] {
  // A feed reads once a minute from registration; simulated sensors every 10 seconds on the clock.
  const step = sensor.mode === "feed" ? FEED_INTERVAL_S : READING_INTERVAL_S;
  const origin = sensor.mode === "feed" ? sensor.registeredAt : 0;
  const out: Reading[] = [];
  for (let t = origin + Math.ceil((start - origin) / step) * step; t <= end; t += step) {
    const tempC = tempAt(sensor, t, profile);
    if (tempC !== null) out.push({ at: t, tempC });
  }
  return out;
}

/** The exact file the sensor commits: `timestamp,temperature_c` rows. Its SHA-256 goes on-chain. */
export function toCsv(readings: Reading[]) {
  return ["timestamp,temperature_c", ...readings.map((r) => `${new Date(r.at * 1000).toISOString()},${r.tempC.toFixed(1)}`)].join("\n") + "\n";
}

/** SHA-256 of the file's exact bytes, as a 0x-prefixed bytes32. */
export const sha256 = (file: string) => "0x" + createHash("sha256").update(file).digest("hex");

/**
 * Parses a sensor export (`timestamp,temperature_c`, any interval) into one temperature per
 * minute from its first reading. Minutes with no reading stay null.
 */
export function parseFeed(csv: string): (number | null)[] {
  const rows = csv.trim().split(/\r?\n/).slice(1).filter(Boolean);
  if (rows.length === 0) throw new Error("The file has no readings");
  if (rows.length > 50_000) throw new Error("The file is too long (50,000 readings at most)");
  const parsed = rows.map((row, i) => {
    const [timestamp, temp] = row.split(",");
    const ms = Date.parse(timestamp);
    const tempC = Number(temp);
    if (Number.isNaN(ms) || Number.isNaN(tempC) || tempC < -60 || tempC > 80) throw new Error(`Row ${i + 2} isn't "timestamp,temperature_c"`);
    return { ms, tempC };
  });
  parsed.sort((a, b) => a.ms - b.ms);
  const first = parsed[0].ms;
  const feed: (number | null)[] = [];
  for (const r of parsed) {
    const k = Math.round((r.ms - first) / 60_000);
    while (feed.length < k) feed.push(null);
    feed[k] = round1(r.tempC);
  }
  return feed;
}
