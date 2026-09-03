/**
 * Render the digest to a file. No network, no saved data needed.
 *
 *   node scripts/preview-email.ts
 *   open .preview/email.html
 *
 * Uses synthetic price series so every verdict state can be eyeballed.
 * To preview the *real* email from saved data, use:
 *   node scripts/run.ts --offline --dry
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { renderDigest, type RouteReport } from "../src/lib/email.ts";
import { evaluate } from "../src/lib/signal.ts";
import { summarize, type Point } from "../src/lib/stats.ts";
import { addDays, daysBetween, today } from "../src/lib/dates.ts";
import { TRIPS } from "../src/lib/trips.ts";

/** Deterministic pseudo-noise so previews don't churn between runs. */
function makeSeries(nDays: number, start: number, drift: number, noise: number, seed: number): Point[] {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
  const end = today();
  return Array.from({ length: nDays }, (_, i) => ({
    date: addDays(end, -(nDays - 1 - i)),
    price: Math.round(Math.max(start + drift * i + rand() * noise * 2, 120)),
  }));
}

interface Shape {
  origin: string;
  series: Point[];
  priceLevel: string | null;
  typical: [number | null, number | null];
}

// One shape per origin, per trip — enough variety to see every card state.
const SHAPES: Record<string, Shape[]> = {
  sju: [
    { origin: "BOS", series: makeSeries(50, 520, -1.8, 18, 7), priceLevel: "low", typical: [380, 720] },
    { origin: "PVD", series: makeSeries(45, 610, 0.4, 22, 11), priceLevel: "typical", typical: [430, 810] },
    { origin: "JFK", series: makeSeries(40, 470, 1.9, 16, 13), priceLevel: "high", typical: [350, 690] },
  ],
  puj: [
    { origin: "BOS", series: makeSeries(60, 700, 1.2, 25, 17), priceLevel: "high", typical: [520, 980] },
    { origin: "PVD", series: makeSeries(30, 860, 0.2, 20, 19), priceLevel: "typical", typical: [600, 1080] },
    { origin: "JFK", series: makeSeries(55, 640, -0.9, 19, 23), priceLevel: "typical", typical: [480, 940] },
  ],
};

const reports: RouteReport[] = TRIPS.flatMap((trip) =>
  (SHAPES[trip.id] ?? []).map((shape) => {
    const summary = summarize(shape.series);
    return {
      tripId: trip.id,
      tripLabel: trip.label,
      origin: shape.origin,
      destination: trip.destination,
      outboundDate: trip.outboundDate,
      returnDate: trip.returnDate,
      currency: "USD",
      summary,
      verdict: evaluate({
        currentPrice: summary.current,
        summary,
        priceLevel: shape.priceLevel,
        typicalLow: shape.typical[0],
        typicalHigh: shape.typical[1],
        departureDate: trip.outboundDate,
      }),
      priceLevel: shape.priceLevel,
      typicalLow: shape.typical[0],
      typicalHigh: shape.typical[1],
      offers: [
        { price: summary.current!, airline: "JetBlue", flightNumbers: "B6 1201", stops: 0, totalDuration: 245, departureTime: null, arrivalTime: null },
        { price: summary.current! + 52, airline: "Delta", flightNumbers: "DL 622", stops: 1, totalDuration: 402, departureTime: null, arrivalTime: null },
        { price: summary.current! + 97, airline: "American", flightNumbers: "AA 318", stops: 1, totalDuration: 448, departureTime: null, arrivalTime: null },
      ],
      // Mark one card stale so that state gets eyeballed too.
      stale: trip.id === "puj" && shape.origin === "PVD",
    };
  }),
);

const { subject, html, text } = renderDigest(reports, [
  "Could not refresh PVD-PUJ-2027-03-07-2027-03-12: SerpApi HTTP 429 (example warning)",
]);

mkdirSync(new URL("../.preview/", import.meta.url), { recursive: true });
writeFileSync(new URL("../.preview/email.html", import.meta.url), html);
writeFileSync(new URL("../.preview/email.txt", import.meta.url), text);

console.log(`\n  Subject: ${subject}\n`);
for (const trip of TRIPS) {
  console.log(`  ${trip.label} — ${daysBetween(today(), trip.outboundDate)} days out`);
  for (const r of reports.filter((x) => x.tripId === trip.id)) {
    console.log(
      `    ${r.origin}  ${r.verdict.action.padEnd(13)} ` +
        `${String(r.summary.current).padStart(5)}  score ${r.verdict.score.toFixed(1).padStart(6)}  ` +
        `conf=${r.verdict.confidence}${r.stale ? "  [stale]" : ""}`,
    );
  }
}
console.log("\n  Wrote .preview/email.html and .preview/email.txt\n");
