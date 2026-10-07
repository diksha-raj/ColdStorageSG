// Unit tests for CSV parsing and summarising (no chain needed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseAndRebase, sha256, summarize } from "../src/replay.ts";

const raw = (name: string) => readFileSync(join(import.meta.dirname, "..", "..", "..", "data", "raw", name));
const LEG_START = 1_800_000_000;

test("rebases readings onto the leg start, keeping one-minute spacing", () => {
  const readings = parseAndRebase(raw("compliant.csv").toString(), LEG_START);
  assert.equal(readings.length, 361);
  assert.equal(readings[0].at, LEG_START);
  assert.equal(readings[1].at, LEG_START + 60);
});

test("compliant file has no excursion above 4 °C", () => {
  const stats = summarize(parseAndRebase(raw("compliant.csv").toString(), LEG_START), 4);
  assert.equal(stats.breachMinutes, 0);
  assert.equal(stats.breachStart, 0);
  assert.ok(stats.maxC <= 4);
});

test("breached file has one excursion longer than the 15-minute grace period", () => {
  const stats = summarize(parseAndRebase(raw("breached.csv").toString(), LEG_START), 4);
  assert.equal(stats.maxC, 7.4);
  assert.ok(stats.breachMinutes > 15, `breach was ${stats.breachMinutes} min`);
  assert.ok(stats.breachStart > LEG_START && stats.breachEnd > stats.breachStart);
  assert.equal(stats.breachMinutes, (stats.breachEnd - stats.breachStart) / 60);
});

test("a looser threshold changes the verdict for the same file", () => {
  const readings = parseAndRebase(raw("breached.csv").toString(), LEG_START);
  assert.ok(summarize(readings, 4).breachMinutes > summarize(readings, 6).breachMinutes);
  assert.equal(summarize(readings, 8).breachMinutes, 0);
});

test("tampered file hides the breach but has a different hash", () => {
  const stats = summarize(parseAndRebase(raw("tampered.csv").toString(), LEG_START), 4);
  assert.equal(stats.breachMinutes, 0);
  assert.notEqual(sha256(raw("tampered.csv")), sha256(raw("breached.csv")));
});

test("an excursion still running at the last reading is counted", () => {
  const readings = [2, 3, 5, 6, 7].map((tempC, i) => ({ at: i * 60, tempC }));
  const stats = summarize(readings, 4);
  assert.equal(stats.breachStart, 120);
  assert.equal(stats.breachEnd, 240);
  assert.equal(stats.breachMinutes, 2);
});

test("picks the longest of several excursions", () => {
  const readings = [5, 3, 5, 5, 5, 3, 5].map((tempC, i) => ({ at: i * 60, tempC }));
  assert.equal(summarize(readings, 4).breachMinutes, 3);
  assert.equal(summarize(readings, 4).breachStart, 120);
});

test("rejects malformed CSV", () => {
  assert.throws(() => parseAndRebase("timestamp,temperature_c\nnot-a-date,abc\n", 0), /Bad CSV row 2/);
  assert.throws(() => parseAndRebase("timestamp,temperature_c\n", 0), /no readings/);
});
