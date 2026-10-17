// Generates the sample sensor exports in data/raw. A participant who picks "Register your sensor
// for this supply" attaches one of these as their sensor's export (the prototype can't reach
// real devices). Seeded, so output is byte-identical on every run.   Run: npx tsx data/generate.ts
//
//   compliant.csv         6 h of readings between ~1.8 and ~3.4 °C
//   breached.csv          the same 6 h, but a cooling failure pushes it above 4 °C for ~40 min
//                         (from minute 150), peaking at 7.4 °C
//   reefer-excursion.csv  6 h from a reefer container's controller: a defrost fault holds it at
//                         ~6.5 °C from minute 2 to 7. Above a 4 °C limit, within an 8 °C one.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const START = Date.UTC(2026, 9, 1, 0, 0, 0); // the gateway reads an export minute by minute from registration
const MINUTES = 360;
const EXCURSION = { from: 150, peakAt: 170, to: 194, peakC: 7.4 };

// Small deterministic PRNG (mulberry32) so the files never change between runs.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(5102);
const baseline = Array.from({ length: MINUTES + 1 }, (_, m) => 2.6 + 0.5 * Math.sin(m / 45) + (random() - 0.5) * 0.4);

function excursion(m: number, base: number) {
  if (m < EXCURSION.from || m > EXCURSION.to) return base;
  const rising = m <= EXCURSION.peakAt;
  const span = rising ? EXCURSION.peakAt - EXCURSION.from : EXCURSION.to - EXCURSION.peakAt;
  const progress = rising ? (m - EXCURSION.from) / span : (EXCURSION.to - m) / span;
  return base + (EXCURSION.peakC - base) * Math.sin((progress * Math.PI) / 2);
}

const breached = baseline.map((t, m) => excursion(m, t));
// A reefer controller's export: 6 hours, with a defrost fault holding it near 6.5 °C.
const reefer = baseline.map((t, m) => (m >= 2 && m <= 7 ? 6.3 + random() * 0.4 : t));

function toCsv(temps: number[]) {
  const rows = temps.map((t, m) => `${new Date(START + m * 60_000).toISOString()},${t.toFixed(1)}`);
  return ["timestamp,temperature_c", ...rows].join("\n") + "\n";
}

const dir = join(import.meta.dirname, "raw");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "compliant.csv"), toCsv(baseline));
writeFileSync(join(dir, "breached.csv"), toCsv(breached));
writeFileSync(join(dir, "reefer-excursion.csv"), toCsv(reefer));
console.log(`Wrote compliant.csv, breached.csv, reefer-excursion.csv to ${dir}`);
