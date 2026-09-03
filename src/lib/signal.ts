/**
 * The buy indicator. Port of python/flighttracker/signal.py.
 *
 * Each input scores -1.0 (wait) .. +1.0 (buy), combined as a weighted average
 * into a -100..+100 score. Components with no data are dropped and the
 * remaining weights renormalized, so a brand-new route degrades gracefully
 * instead of silently scoring missing data as neutral.
 *
 * Momentum sign convention: rising prices push *toward* buying (the window is
 * closing), falling prices push toward waiting (the trend is your friend).
 */

import { daysBetween, today } from "./dates.ts";
import type { SeriesSummary, Window } from "./stats.ts";

export const ACTIONS = {
  BUY_NOW: "BUY NOW",
  BUY_SOON: "BUY SOON",
  HOLD: "HOLD",
  WAIT: "WAIT",
  STRONG_WAIT: "KEEP WAITING",
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

export const ACTION_BLURB: Record<Action, string> = {
  [ACTIONS.BUY_NOW]: "Book today. Conditions are as good as they are likely to get.",
  [ACTIONS.BUY_SOON]: "Start watching daily and be ready to book within a week or two.",
  [ACTIONS.HOLD]: "Nothing decisive either way. Keep collecting data.",
  [ACTIONS.WAIT]: "No reason to book yet. Prices have room to come down.",
  [ACTIONS.STRONG_WAIT]: "Do not book. It is early and the trend favors waiting.",
};

export const DEFAULT_WEIGHTS = {
  googlePriceLevel: 25,
  typicalRangePosition: 15,
  historyPercentile: 20,
  momentum7d: 15,
  momentum30d: 10,
  deadlinePressure: 15,
} as const;

export const DEFAULT_THRESHOLDS = {
  buyNow: 45,
  buySoon: 25,
  hold: -10,
  wait: -35,
} as const;

export type Weights = typeof DEFAULT_WEIGHTS;
export type Thresholds = typeof DEFAULT_THRESHOLDS;

export interface Component {
  name: string;
  score: number;
  weight: number;
  reason: string;
  contribution: number;
}

export interface Verdict {
  action: Action;
  blurb: string;
  score: number;
  confidence: "low" | "medium" | "high";
  components: Component[];
  notes: string[];
  targetPrice: number | null;
  daysToDeparture: number;
}

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function comp(name: string, score: number, weight: number, reason: string): Component {
  return { name, score, weight, reason, contribution: score * weight };
}

export function deadlinePressure(daysOut: number): [number, string] {
  if (daysOut > 180)
    return [-0.6, `${daysOut} days out — very early; fares typically still soften from here`];
  if (daysOut > 120)
    return [-0.3, `${daysOut} days out — still early; the prime booking window hasn't opened`];
  if (daysOut > 90) return [0.0, `${daysOut} days out — approaching the prime booking window`];
  if (daysOut > 60) return [0.35, `${daysOut} days out — inside the prime booking window`];
  if (daysOut > 21)
    return [0.7, `${daysOut} days out — prime window closing, fares usually climb from here`];
  if (daysOut > 14)
    return [0.9, `only ${daysOut} days out — last-minute pricing is taking over`];
  return [1.0, `only ${daysOut} days out — fares now move one direction`];
}

function priceLevelComponent(level: string | null, weight: number): Component | null {
  if (!level) return null;
  const map: Record<string, [number, string]> = {
    low: [1.0, "Google rates this fare LOW for the route — a genuine buy signal"],
    typical: [0.0, "Google rates this fare TYPICAL — no edge either way"],
    high: [-0.8, "Google rates this fare HIGH — you are paying a premium right now"],
  };
  const hit = map[level.toLowerCase()] ?? [0.0, `Google price level: ${level}`];
  return comp("googlePriceLevel", hit[0], weight, hit[1]);
}

function typicalRangeComponent(
  price: number | null, lo: number | null, hi: number | null, weight: number,
): Component | null {
  if (price === null || lo === null || hi === null || hi <= lo) return null;
  const position = (price - lo) / (hi - lo);
  const score = clamp(1.0 - 2.0 * position);

  let reason: string;
  if (position <= 0) reason = `${money(price)} is below the typical band (${money(lo)}-${money(hi)})`;
  else if (position >= 1) reason = `${money(price)} is above the typical band (${money(lo)}-${money(hi)})`;
  else
    reason = `${money(price)} sits at the ${(position * 100).toFixed(0)}% mark of the typical band (${money(lo)}-${money(hi)})`;

  return comp("typicalRangePosition", score, weight, reason);
}

function historyComponent(summary: SeriesSummary, weight: number): Component | null {
  if (summary.pctRank === null || summary.nDays < 5) return null;
  const score = clamp(2.0 * summary.pctRank - 1.0);
  const reason =
    `cheaper than ${(summary.pctRank * 100).toFixed(0)}% of the ${summary.nDays} daily prices logged ` +
    `(range ${money(summary.minimum!)}-${money(summary.maximum!)})`;
  return comp("historyPercentile", score, weight, reason);
}

function momentumComponent(
  window: Window, weight: number, name: string, fullScalePct: number,
): Component | null {
  const pct = window.deltaPct;
  if (pct === null || window.previousN < 2) return null;

  const score = clamp(pct / fullScalePct);
  const label = `${window.days}-day`;
  const from = money(window.previousAvg!);
  const to = money(window.currentAvg!);

  let reason: string;
  if (window.direction === "rising")
    reason = `${label} average is up ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs the prior ${window.days} days (${from} → ${to}) — waiting is costing you`;
  else if (window.direction === "falling")
    reason = `${label} average is down ${pct.toFixed(1)}% vs the prior ${window.days} days (${from} → ${to}) — the trend favors waiting`;
  else
    reason = `${label} average is flat (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) — no momentum either way`;

  return comp(name, score, weight, reason);
}

function confidenceOf(summary: SeriesSummary, hasInsights: boolean): Verdict["confidence"] {
  if (summary.nDays >= 21 && hasInsights) return "high";
  if (summary.nDays >= 7) return "medium";
  return "low";
}

function actionFor(score: number, t: Thresholds): Action {
  if (score >= t.buyNow) return ACTIONS.BUY_NOW;
  if (score >= t.buySoon) return ACTIONS.BUY_SOON;
  if (score >= t.hold) return ACTIONS.HOLD;
  if (score >= t.wait) return ACTIONS.WAIT;
  return ACTIONS.STRONG_WAIT;
}

function targetPriceOf(summary: SeriesSummary, typicalLow: number | null): number | null {
  const candidates: number[] = [];
  if (typicalLow) candidates.push(typicalLow);
  if (summary.minimum !== null && summary.mean !== null && summary.nDays >= 5) {
    candidates.push(
      Math.round((summary.minimum + (summary.mean - summary.minimum) * 0.25) * 100) / 100,
    );
  }
  return candidates.length ? Math.min(...candidates) : null;
}

export interface EvaluateInput {
  currentPrice: number | null;
  summary: SeriesSummary;
  priceLevel: string | null;
  typicalLow: number | null;
  typicalHigh: number | null;
  departureDate: string;
  weights?: Weights;
  thresholds?: Thresholds;
  asOf?: string;
}

export function evaluate(input: EvaluateInput): Verdict {
  const {
    currentPrice, summary, priceLevel, typicalLow, typicalHigh, departureDate,
    weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS, asOf = today(),
  } = input;

  const daysOut = daysBetween(asOf, departureDate);
  const notes: string[] = [];

  const components = [
    priceLevelComponent(priceLevel, weights.googlePriceLevel),
    typicalRangeComponent(currentPrice, typicalLow, typicalHigh, weights.typicalRangePosition),
    historyComponent(summary, weights.historyPercentile),
    momentumComponent(summary.week, weights.momentum7d, "momentum7d", 5.0),
    momentumComponent(summary.month, weights.momentum30d, "momentum30d", 8.0),
  ].filter((c): c is Component => c !== null);

  const [pressureScore, pressureReason] = deadlinePressure(daysOut);
  components.push(
    comp("deadlinePressure", pressureScore, weights.deadlinePressure, pressureReason),
  );

  // A "wait" signal is only worth acting on if there is time to act on it. As
  // departure closes in, damp the wait-leaning components — the hotel is
  // booked, so "don't fly" was never one of the options.
  const runway = clamp(daysOut / 60.0, 0.15, 1.0);
  const totalWeight = components.reduce((acc, c) => acc + c.weight, 0);

  let raw = 0;
  for (const c of components) {
    let contribution = c.contribution;
    if (contribution < 0 && c.name !== "deadlinePressure") contribution *= runway;
    raw += contribution;
  }

  const score = totalWeight ? Math.round((raw / totalWeight) * 1000) / 10 : 0;
  if (runway < 1.0) {
    notes.push(
      `With ${daysOut} days left, wait signals are damped to ${(runway * 100).toFixed(0)}% — ` +
        `there is limited runway for a better price.`,
    );
  }

  let action = actionFor(score, thresholds);

  // --- Overrides ---
  if (daysOut > 200 && action === ACTIONS.BUY_NOW) {
    action = ACTIONS.BUY_SOON;
    notes.push(
      "Capped at BUY SOON: it is more than 200 days out, and fares this early are usually beatable.",
    );
  }

  if (daysOut <= 10) {
    if (action !== ACTIONS.BUY_NOW) {
      action = ACTIONS.BUY_NOW;
      notes.push(
        `Override: ${daysOut} days out. There is no meaningful upside left in waiting — book the best option available.`,
      );
    }
  } else if (
    // Either window rising counts: a flat week inside a strongly rising month
    // is still a closing window, and this close in there's no time to wait it out.
    daysOut <= 21 &&
    (summary.week.direction === "rising" || summary.month.direction === "rising")
  ) {
    if (action === ACTIONS.HOLD || action === ACTIONS.WAIT || action === ACTIONS.STRONG_WAIT) {
      action = daysOut <= 14 ? ACTIONS.BUY_NOW : ACTIONS.BUY_SOON;
      notes.push(
        `Override: ${daysOut} days out with prices still rising. Waiting has a poor expected value this close in.`,
      );
    }
  }

  const isRecordLow =
    currentPrice !== null &&
    summary.minimum !== null &&
    summary.nDays >= 10 &&
    currentPrice <= summary.minimum;

  if (isRecordLow && (priceLevel ?? "").toLowerCase() === "low" && daysOut <= 150) {
    if (action !== ACTIONS.BUY_NOW) {
      action = ACTIONS.BUY_NOW;
      notes.push(
        "Override: this is the lowest price logged so far AND Google rates it low, with the booking window open.",
      );
    }
  }

  if (summary.nDays < 5) {
    notes.push(
      `Only ${summary.nDays} day(s) of price history so far. The trend components are still dark — treat this verdict as provisional.`,
    );
  }

  return {
    action,
    blurb: ACTION_BLURB[action],
    score,
    confidence: confidenceOf(summary, priceLevel !== null),
    components,
    notes,
    targetPrice: targetPriceOf(summary, typicalLow),
    daysToDeparture: daysOut,
  };
}
