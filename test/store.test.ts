/**
 * Persistence regression tests. Runs against a temp directory via
 * FLIGHT_TRACKER_DATA_DIR so the real data/prices.csv is never touched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const DIR = mkdtempSync(join(tmpdir(), "ft-store-"));
process.env.FLIGHT_TRACKER_DATA_DIR = DIR;

const store = await import("../src/lib/store.ts");

after(() => rmSync(DIR, { recursive: true, force: true }));

const ROUTE = "BOS-SJU-2027-01-04-2027-01-11";
const OTHER = "JFK-PUJ-2027-03-07-2027-03-12";

test("empty store reads as empty", () => {
  assert.deepEqual(store.readAllRows(), []);
  assert.deepEqual(store.readSeries(ROUTE), []);
  assert.deepEqual(store.readLatest(), { updatedAt: "", routes: {} });
});

test("merge writes rows and readSeries returns them sorted", () => {
  const changed = store.mergePriceBatches([
    {
      routeKey: ROUTE,
      source: "observed",
      points: [
        { date: "2026-09-03", price: 512 },
        { date: "2026-09-01", price: 530 },
        { date: "2026-09-02", price: 498 },
      ],
    },
  ]);
  assert.equal(changed, 3);

  const series = store.readSeries(ROUTE);
  assert.deepEqual(
    series.map((p) => p.date),
    ["2026-09-01", "2026-09-02", "2026-09-03"],
    "series is sorted oldest first",
  );
  assert.equal(series[2]!.price, 512);
});

test("re-merging the same day keeps the cheaper price, never duplicates", () => {
  const before = store.readSeries(ROUTE).length;

  store.mergePriceBatches([
    { routeKey: ROUTE, source: "observed", points: [{ date: "2026-09-03", price: 601 }] },
  ]);
  assert.equal(store.readSeries(ROUTE).length, before, "no duplicate row for the same day");
  assert.equal(
    store.readSeries(ROUTE).at(-1)!.price, 512,
    "a higher price does not overwrite the cheaper one",
  );

  store.mergePriceBatches([
    { routeKey: ROUTE, source: "observed", points: [{ date: "2026-09-03", price: 455 }] },
  ]);
  assert.equal(store.readSeries(ROUTE).at(-1)!.price, 455, "a cheaper price does overwrite");
  assert.equal(store.readSeries(ROUTE).length, before, "still no duplicate");
});

test("observed wins over google_history on the same date", () => {
  store.mergePriceBatches([
    { routeKey: ROUTE, source: "google_history", points: [{ date: "2026-09-02", price: 300 }] },
  ]);
  const point = store.readSeries(ROUTE).find((p) => p.date === "2026-09-02");
  assert.equal(point!.price, 498, "prefers our own observation even when cheaper history exists");
});

test("google_history fills days we have no observation for", () => {
  store.mergePriceBatches([
    { routeKey: ROUTE, source: "google_history", points: [{ date: "2026-08-20", price: 610 }] },
  ]);
  const point = store.readSeries(ROUTE).find((p) => p.date === "2026-08-20");
  assert.equal(point!.price, 610);
});

test("routes are isolated from each other", () => {
  store.mergePriceBatches([
    { routeKey: OTHER, source: "observed", points: [{ date: "2026-09-02", price: 999 }] },
  ]);
  assert.equal(store.readSeries(OTHER).length, 1);
  assert.ok(
    store.readSeries(ROUTE).every((p) => p.price !== 999),
    "the other route's prices don't leak in",
  );
});

test("csv stays well-formed and header-first", () => {
  const raw = readFileSync(join(DIR, "prices.csv"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines[0], "route_key,date,price,source");
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, 4, `malformed row: ${line}`);
  }
  assert.ok(raw.endsWith("\n"), "file ends with a newline");
});

test("writeLatest merges rather than replacing", () => {
  const reading = {
    origin: "BOS", destination: "SJU",
    outboundDate: "2027-01-04", returnDate: "2027-01-11",
    currency: "USD", capturedAt: new Date().toISOString(),
    lowestPrice: 455, avgPrice: 512, medianPrice: 500, nOffers: 12,
    priceLevel: "low", typicalLow: 380, typicalHigh: 720, offers: [],
  };
  store.writeLatest({ [ROUTE]: reading });
  store.writeLatest({ [OTHER]: { ...reading, origin: "JFK", destination: "PUJ" } });

  const latest = store.readLatest();
  assert.ok(latest.routes[ROUTE], "the earlier route survives a later write");
  assert.ok(latest.routes[OTHER], "the newer route is present");
  assert.equal(latest.routes[ROUTE]!.lowestPrice, 455);
});
