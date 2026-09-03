/**
 * The whole job. Poll every route, update the CSV history, compute verdicts,
 * email the digest.
 *
 *   node scripts/run.ts              poll, save, email
 *   node scripts/run.ts --dry        poll and save, print instead of emailing
 *   node scripts/run.ts --offline    no API calls; report from saved data
 *   node scripts/run.ts --no-save    poll, but don't touch data/
 *
 * Exit code is 1 if every route failed, or if the email couldn't be sent —
 * so a failed GitHub Actions run is itself the fallback notification.
 */

import { today } from "../src/lib/dates.ts";
import { renderDigest, sendDigest, type RouteReport } from "../src/lib/email.ts";
import { fetchRoute, ProviderError } from "../src/lib/serpapi.ts";
import { evaluate } from "../src/lib/signal.ts";
import { summarize } from "../src/lib/stats.ts";
import * as store from "../src/lib/store.ts";
import { SEARCH, allRoutes, type Route } from "../src/lib/trips.ts";

const CONCURRENCY = 3;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry");
const offline = args.has("--offline");
const noSave = args.has("--no-save");

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await fn(items[cursor++]!);
    }),
  );
}

const runDate = today();
const routes = allRoutes();
const errors: { route: string; error: string }[] = [];
const batches: store.PriceBatch[] = [];
const readings: Record<string, store.LatestReading> = {};

// --- 1. poll ---
if (offline) {
  console.log("  offline mode — using saved data, no API calls\n");
} else {
  console.log(`  polling ${routes.length} routes…\n`);
  await mapLimit(routes, CONCURRENCY, async (route: Route) => {
    try {
      const result = await fetchRoute({
        origin: route.origin,
        destination: route.destination,
        outboundDate: route.outboundDate,
        returnDate: route.returnDate,
        adults: SEARCH.adults,
        currency: SEARCH.currency,
        travelClass: SEARCH.travelClass,
        stops: SEARCH.stops,
      });

      if (result.lowestPrice !== null) {
        batches.push({
          routeKey: route.key,
          points: [{ date: runDate, price: result.lowestPrice }],
          source: "observed",
        });
      }
      // Google's own history gives a new route weeks of trend on day one.
      if (result.history.length) {
        batches.push({ routeKey: route.key, points: result.history, source: "google_history" });
      }

      readings[route.key] = {
        origin: route.origin,
        destination: route.destination,
        outboundDate: route.outboundDate,
        returnDate: route.returnDate,
        currency: SEARCH.currency,
        capturedAt: new Date().toISOString(),
        lowestPrice: result.lowestPrice,
        avgPrice: result.avgPrice,
        medianPrice: result.medianPrice,
        nOffers: result.nOffers,
        priceLevel: result.priceLevel,
        typicalLow: result.typicalLow,
        typicalHigh: result.typicalHigh,
        offers: result.offers.slice(0, 5),
      };

      console.log(
        `    ${route.key.padEnd(34)} $${result.lowestPrice} ` +
          `(${result.priceLevel ?? "?"}), +${result.history.length} history`,
      );
    } catch (cause) {
      const message = cause instanceof ProviderError ? cause.message : String(cause);
      errors.push({ route: route.key, error: message });
      console.error(`    ${route.key.padEnd(34)} FAILED: ${message}`);
    }
  });
}

// --- 2. save ---
if (!noSave && !offline) {
  const changed = store.mergePriceBatches(batches);
  store.writeLatest(readings);
  console.log(`\n  saved ${changed} price rows\n`);
}

// --- 3. verdicts ---
const latest = store.readLatest();
const reports: RouteReport[] = [];

for (const route of routes) {
  const reading = readings[route.key] ?? latest.routes[route.key];
  if (!reading) continue;

  const series = store.readSeries(route.key);
  const summary = summarize(series);
  if (summary.current === null) continue;

  reports.push({
    tripId: route.id,
    tripLabel: route.label,
    origin: route.origin,
    destination: route.destination,
    outboundDate: route.outboundDate,
    returnDate: route.returnDate,
    currency: reading.currency,
    summary,
    verdict: evaluate({
      currentPrice: reading.lowestPrice ?? summary.current,
      summary,
      priceLevel: reading.priceLevel,
      typicalLow: reading.typicalLow,
      typicalHigh: reading.typicalHigh,
      departureDate: route.outboundDate,
      asOf: runDate,
    }),
    priceLevel: reading.priceLevel,
    typicalLow: reading.typicalLow,
    typicalHigh: reading.typicalHigh,
    offers: reading.offers,
    // Fell back to a stored reading because today's fetch failed.
    stale: !offline && readings[route.key] === undefined,
  });
}

if (reports.length === 0) {
  console.error("\n  No route produced a report — nothing to send.");
  for (const e of errors) console.error(`    ${e.route}: ${e.error}`);
  process.exit(1);
}

// --- 4. email ---
// Surface fetch failures in the email itself, so a stale price can never
// quietly look like a fresh one.
const notes = errors.map((e) => `Could not refresh ${e.route}: ${e.error}`);
const { subject, html, text } = renderDigest(reports, notes);

console.log(`  ${subject}\n`);
for (const r of reports) {
  console.log(
    `    ${r.destination} ${r.origin}  ${r.verdict.action.padEnd(13)} ` +
      `${String(r.summary.current).padStart(5)}  ` +
      `score ${r.verdict.score.toFixed(1).padStart(6)}  ` +
      `${r.verdict.daysToDeparture}d  conf=${r.verdict.confidence}${r.stale ? "  [stale]" : ""}`,
  );
}

let failed = false;

if (dryRun) {
  console.log("\n  --dry: not sending email\n");
} else {
  const result = await sendDigest(subject, html, text);
  if (result.ok) {
    console.log(`\n  emailed ${process.env.EMAIL_TO}\n`);
  } else {
    console.error(`\n  EMAIL FAILED: ${result.error}\n`);
    failed = true;
  }
}

if (errors.length) {
  console.error(`  ${errors.length} route(s) failed to refresh:`);
  for (const e of errors) console.error(`    ${e.route}: ${e.error}`);
}

process.exit(failed ? 1 : 0);
