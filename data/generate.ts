// Generates the three demo sensor files in data/raw. Seeded, so output is byte-identical
// on every run (and so are the SHA-256 hashes).   Run: npx tsx data/generate.ts
//
//   compliant.csv  6 h of readings between ~1.8 and ~3.4 °C
//   breached.csv   same leg, but a cooling failure pushes it above 4 °C for ~40 min
//   tampered.csv   breached.csv with the excursion edited down to 3.9 °C to hide it;
//                  it no longer matches the hash the sensor committed
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const START = Date.UTC(2026, 9, 1, 0, 0, 0); // readings are rebased onto the real leg window at replay
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
const tampered = breached.map((t) => Math.min(t, 3.9));

function toCsv(temps: number[]) {
  const rows = temps.map((t, m) => `${new Date(START + m * 60_000).toISOString()},${t.toFixed(1)}`);
  return ["timestamp,temperature_c", ...rows].join("\n") + "\n";
}

const dir = join(import.meta.dirname, "raw");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "compliant.csv"), toCsv(baseline));
writeFileSync(join(dir, "breached.csv"), toCsv(breached));
writeFileSync(join(dir, "tampered.csv"), toCsv(tampered));
console.log(`Wrote compliant.csv, breached.csv, tampered.csv to ${dir}`);
