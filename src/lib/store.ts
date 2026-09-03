/**
 * Storage is the git repo itself.
 *
 * `data/prices.csv` is the durable daily series — append-only, one row per
 * (route, date, source), committed by the workflow each day. Plain text so
 * every change shows up as a readable diff and history is never lost.
 *
 * `data/latest.json` holds the most recent full reading per route (price level,
 * typical band, cheapest offers) which is all the email needs beyond the series.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Offer } from "./serpapi.ts";
import type { Point } from "./stats.ts";

// Overridable so tests can write to a temp dir instead of the real history.
const DATA_DIR = process.env.FLIGHT_TRACKER_DATA_DIR
  ? process.env.FLIGHT_TRACKER_DATA_DIR.replace(/\/?$/, "/")
  : fileURLToPath(new URL("../../data/", import.meta.url));

const PRICES_CSV = `${DATA_DIR}prices.csv`;
const LATEST_JSON = `${DATA_DIR}latest.json`;

const CSV_HEADER = "route_key,date,price,source";

export interface PriceRow {
  routeKey: string;
  date: string;
  price: number;
  source: string;
}

export interface LatestReading {
  origin: string;
  destination: string;
  outboundDate: string;
  returnDate: string | null;
  currency: string;
  capturedAt: string;
  lowestPrice: number | null;
  avgPrice: number | null;
  medianPrice: number | null;
  nOffers: number;
  priceLevel: string | null;
  typicalLow: number | null;
  typicalHigh: number | null;
  offers: Offer[];
}

export interface LatestFile {
  updatedAt: string;
  routes: Record<string, LatestReading>;
}

function rowId(row: PriceRow): string {
  return `${row.routeKey}|${row.date}|${row.source}`;
}

export function readAllRows(): PriceRow[] {
  if (!existsSync(PRICES_CSV)) return [];
  const lines = readFileSync(PRICES_CSV, "utf8").split("\n");
  const rows: PriceRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === CSV_HEADER) continue;
    const [routeKey, date, price, source] = trimmed.split(",");
    if (!routeKey || !date || !price) continue;
    const parsed = Number(price);
    if (!Number.isFinite(parsed)) continue;
    rows.push({ routeKey, date, price: parsed, source: source || "observed" });
  }
  return rows;
}

function writeAllRows(rows: PriceRow[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const sorted = [...rows].sort(
    (a, b) =>
      a.routeKey.localeCompare(b.routeKey) ||
      a.date.localeCompare(b.date) ||
      a.source.localeCompare(b.source),
  );
  const body = sorted.map((r) => `${r.routeKey},${r.date},${r.price},${r.source}`);
  writeFileSync(PRICES_CSV, [CSV_HEADER, ...body].join("\n") + "\n");
}

export interface PriceBatch {
  routeKey: string;
  points: Point[];
  source: string;
}

/**
 * Merge batches of price points into the CSV, keeping the cheapest price seen
 * for any given (route, date, source). Reads and writes the file once for the
 * whole set. Returns how many rows were new or improved.
 */
export function mergePriceBatches(batches: PriceBatch[]): number {
  const index = new Map(readAllRows().map((row) => [rowId(row), row]));
  let changed = 0;

  for (const batch of batches) {
    for (const point of batch.points) {
      const row: PriceRow = {
        routeKey: batch.routeKey,
        date: point.date,
        price: Math.round(point.price),
        source: batch.source,
      };
      const current = index.get(rowId(row));
      if (!current) {
        index.set(rowId(row), row);
        changed++;
      } else if (row.price < current.price) {
        current.price = row.price;
        changed++;
      }
    }
  }

  if (changed > 0) writeAllRows([...index.values()]);
  return changed;
}

/**
 * Daily series for a route, oldest first. Prefers our own observations and
 * falls back to Google's backfilled history for days we weren't running yet.
 */
export function readSeries(routeKey: string): Point[] {
  const byDate = new Map<string, { observed?: number; other?: number }>();

  for (const row of readAllRows()) {
    if (row.routeKey !== routeKey) continue;
    const bucket = byDate.get(row.date) ?? {};
    if (row.source === "observed") {
      bucket.observed = Math.min(bucket.observed ?? Infinity, row.price);
    } else {
      bucket.other = Math.min(bucket.other ?? Infinity, row.price);
    }
    byDate.set(row.date, bucket);
  }

  return [...byDate.entries()]
    .map(([date, bucket]) => ({ date, price: bucket.observed ?? bucket.other! }))
    .filter((p) => Number.isFinite(p.price))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function readLatest(): LatestFile {
  if (!existsSync(LATEST_JSON)) return { updatedAt: "", routes: {} };
  try {
    return JSON.parse(readFileSync(LATEST_JSON, "utf8")) as LatestFile;
  } catch {
    return { updatedAt: "", routes: {} };
  }
}

/** Merge readings into latest.json, leaving routes we couldn't refresh intact. */
export function writeLatest(readings: Record<string, LatestReading>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const current = readLatest();
  const merged: LatestFile = {
    updatedAt: new Date().toISOString(),
    routes: { ...current.routes, ...readings },
  };
  writeFileSync(LATEST_JSON, JSON.stringify(merged, null, 2) + "\n");
}
