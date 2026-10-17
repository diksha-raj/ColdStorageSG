// Unit tests for the simulated sensors (no chain needed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseFeed, readingsBetween, sha256, toCsv } from "../src/simulate.ts";

const T0 = 1_800_000_000; // registration time, unix seconds
const CHILLED = { lowestLimitC: 4, highestLimitC: 4 };
const FROZEN = { lowestLimitC: -10, highestLimitC: -10 };
const sensor = (mode: "compliant" | "breached" | "feed", feed: (number | null)[] | null = null) => ({ sensorId: `TEST-${mode}`, mode, registeredAt: T0, feed });
const temps = (r: { tempC: number }[]) => r.map((x) => x.tempC);

test("a simulated sensor reads every 10 seconds, at real times", () => {
  const r = readingsBetween(sensor("compliant"), T0, T0 + 120, CHILLED);
  assert.equal(r.length, 13);
  assert.equal(r[1].at - r[0].at, 10);
});

test("a compliant sensor holds below the limit it was registered for, chilled or frozen", () => {
  const chilled = temps(readingsBetween(sensor("compliant"), T0, T0 + 3600, CHILLED));
  assert.ok(Math.max(...chilled) < 4 && Math.min(...chilled) > 1, `${Math.min(...chilled)}..${Math.max(...chilled)}`);
  const frozen = temps(readingsBetween(sensor("compliant"), T0, T0 + 3600, FROZEN));
  assert.ok(Math.max(...frozen) < -10 && Math.min(...frozen) > -13, `${Math.min(...frozen)}..${Math.max(...frozen)}`);
});

test("a sensor covering batches with different limits holds below the tightest", () => {
  const mixed = temps(readingsBetween(sensor("compliant"), T0, T0 + 3600, { lowestLimitC: 4, highestLimitC: 8 }));
  assert.ok(Math.max(...mixed) < 4);
});

test("a breached sensor fails a minute after registration and climbs well past the limit", () => {
  for (const profile of [CHILLED, FROZEN]) {
    const limit = profile.lowestLimitC;
    const r = readingsBetween(sensor("breached"), T0, T0 + 600, profile);
    assert.ok(r.filter((x) => x.at < T0 + 60).every((x) => x.tempC < limit), "healthy at first");
    const failed = r.filter((x) => x.at >= T0 + 240);
    assert.ok(failed.every((x) => x.tempC > limit + 4.5), `failed and holding above ${limit} °C: ${temps(failed).slice(0, 3)}`);
  }
});

test("readings are deterministic, so the same window always hashes the same", () => {
  const a = toCsv(readingsBetween(sensor("breached"), T0, T0 + 300, CHILLED));
  const b = toCsv(readingsBetween(sensor("breached"), T0, T0 + 300, CHILLED));
  assert.equal(sha256(a), sha256(b));
  assert.ok(a.startsWith("timestamp,temperature_c\n"));
});

test("an attached export is read a minute at a time from registration, and stops when it runs out", () => {
  const csv = readFileSync(join(import.meta.dirname, "..", "..", "..", "data", "raw", "breached.csv"), "utf8");
  const feed = parseFeed(csv);
  assert.equal(feed.length, 361);
  const r = readingsBetween(sensor("feed", feed), T0, T0 + 400 * 60, CHILLED);
  assert.equal(r.length, 361, "no readings once the export ends");
  assert.equal(r[1].at - r[0].at, 60);
  assert.equal(r[0].tempC, feed[0]);
  assert.equal(Math.max(...temps(r)), 7.4);
});

test("exports with a different interval keep one value per minute, with gaps left empty", () => {
  const feed = parseFeed("timestamp,temperature_c\n2027-01-01T00:00:00Z,2\n2027-01-01T00:05:00Z,3\n");
  assert.deepEqual(feed, [2, null, null, null, null, 3]);
  assert.throws(() => parseFeed("timestamp,temperature_c\nnot a date,3\n"), /Row 2/);
});
