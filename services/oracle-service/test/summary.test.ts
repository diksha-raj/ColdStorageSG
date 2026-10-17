// Unit tests for summarising a stage's readings (no chain needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, sha256, summarize } from "../src/summary.ts";

const START = 1_800_000_000;
/** One reading a minute. */
const series = (temps: number[], start = START) => temps.map((tempC, i) => ({ at: start + i * 60, tempC }));
const end = (n: number) => START + n * 60;

test("a compliant window has no excursion and no missing minutes", () => {
  const s = summarize(series([2.5, 2.8, 3.1, 2.9, 2.7]), 4, START, end(4));
  assert.deepEqual([s.minC, s.maxC, s.breachMinutes, s.missingMinutes, s.breachStart], [2.5, 3.1, 0, 0, 0]);
});

test("the longest excursion runs to the first reading back within the limit, in real minutes", () => {
  const s = summarize(series([3, 5, 6, 7, 3, 5, 3]), 4, START, end(6));
  assert.equal(s.breachMinutes, 3);
  assert.equal(s.breachStart, end(1));
  assert.equal(s.breachEnd, end(4));
  assert.equal(s.maxC, 7);
});

test("an excursion still running at the last reading is counted", () => {
  assert.equal(summarize(series([2, 3, 5, 6, 7]), 4, START, end(4)).breachMinutes, 2);
});

test("each batch is judged against its own limit, frozen ones included", () => {
  const readings = series([3, 6, 7, 7, 3]);
  assert.equal(summarize(readings, 4, START, end(4)).breachMinutes, 3);
  assert.equal(summarize(readings, 8, START, end(4)).breachMinutes, 0);
  const frozen = series([-12, -11, -8, -7, -11]);
  assert.equal(summarize(frozen, -10, START, end(4)).breachMinutes, 2);
});

test("only readings inside the batch's own window count", () => {
  const s = summarize(series([9, 9, 3, 3, 3, 9, 9]), 4, end(2), end(4));
  assert.equal(s.maxC, 3);
  assert.equal(s.breachMinutes, 0);
});

test("stretches without readings add up as missing minutes, using the sensor's own interval", () => {
  // A sensor reading every 10 seconds, silent from 0:30 to 5:30.
  const readings = [0, 10, 20, 30, 330, 340].map((s) => ({ at: START + s, tempC: 3 }));
  assert.equal(summarize(readings, 4, START, START + 340).missingMinutes, 5);
  // Once a minute: a reading at minutes 3, 4 and 10 of a 12-minute window.
  const sparse = [3, 4, 10].map((m) => ({ at: end(m), tempC: 3 }));
  assert.equal(summarize(sparse, 4, START, end(12)).missingMinutes, 8);
});

test("a window with no readings at all is entirely missing", () => {
  assert.equal(summarize([], 4, START, end(30)).missingMinutes, 30);
});

test("parses the gateway's file and hashes its exact bytes", () => {
  const csv = "timestamp,temperature_c\n2027-01-01T00:00:00.000Z,2.5\n2027-01-01T00:00:10.000Z,4.5\n";
  assert.deepEqual(parseCsv(csv), [
    { at: Date.parse("2027-01-01T00:00:00Z") / 1000, tempC: 2.5 },
    { at: Date.parse("2027-01-01T00:00:10Z") / 1000, tempC: 4.5 },
  ]);
  assert.notEqual(sha256(csv), sha256(csv.replace("4.5", "3.9")));
});
