/**
 * Rolling-window statistics over a daily price series.
 * Direct port of python/flighttracker/stats.py — behavior is covered by
 * test/stats.test.ts, which asserts parity with the Python results.
 */

import { addDays, daysBetween, parseDate } from "./dates.ts";

export interface Point {
  date: string;
  price: number;
}

export type Direction = "rising" | "falling" | "flat" | "unknown";

export interface Window {
  days: number;
  currentAvg: number | null;
  previousAvg: number | null;
  currentN: number;
  previousN: number;
  deltaAbs: number | null;
  deltaPct: number | null;
  direction: Direction;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function directionOf(deltaPct: number | null): Direction {
  if (deltaPct === null) return "unknown";
  if (deltaPct > 1.5) return "rising";
  if (deltaPct < -1.5) return "falling";
  return "flat";
}

export function rollingWindow(series: Point[], days: number, asOf?: string): Window {
  if (series.length === 0) {
    return {
      days, currentAvg: null, previousAvg: null, currentN: 0, previousN: 0,
      deltaAbs: null, deltaPct: null, direction: "unknown",
    };
  }

  const end = asOf ?? series[series.length - 1]!.date;
  const curStart = addDays(end, -(days - 1));
  const prevStart = addDays(curStart, -days);

  const endMs = parseDate(end);
  const curStartMs = parseDate(curStart);
  const prevStartMs = parseDate(prevStart);

  const current: number[] = [];
  const previous: number[] = [];
  for (const p of series) {
    const ms = parseDate(p.date);
    if (ms >= curStartMs && ms <= endMs) current.push(p.price);
    else if (ms >= prevStartMs && ms < curStartMs) previous.push(p.price);
  }

  const currentAvg = current.length ? round(mean(current)) : null;
  const previousAvg = previous.length ? round(mean(previous)) : null;
  const deltaAbs =
    currentAvg !== null && previousAvg !== null ? currentAvg - previousAvg : null;
  const deltaPct =
    currentAvg !== null && previousAvg !== null && previousAvg !== 0
      ? ((currentAvg - previousAvg) / previousAvg) * 100
      : null;

  return {
    days,
    currentAvg,
    previousAvg,
    currentN: current.length,
    previousN: previous.length,
    deltaAbs,
    deltaPct,
    direction: directionOf(deltaPct),
  };
}

/** Fraction of observed prices *higher* than `value`. 1.0 = cheapest ever seen. */
export function percentileRank(series: Point[], value: number): number | null {
  if (series.length < 2) return null;
  const higher = series.filter((p) => p.price > value).length;
  return higher / series.length;
}

/** Least-squares slope in currency units per day over the recent window. */
export function trendSlope(series: Point[], days = 14): number | null {
  if (series.length < 3) return null;
  const recent = series.slice(-days);
  if (recent.length < 3) return null;

  const origin = recent[0]!.date;
  const xs = recent.map((p) => daysBetween(origin, p.date));
  const ys = recent.map((p) => p.price);
  const meanX = mean(xs);
  const meanY = mean(ys);

  const denom = xs.reduce((acc, x) => acc + (x - meanX) ** 2, 0);
  if (denom === 0) return null;

  const num = xs.reduce((acc, x, i) => acc + (x - meanX) * (ys[i]! - meanY), 0);
  return round(num / denom);
}

export interface SeriesSummary {
  nDays: number;
  firstDate: string | null;
  lastDate: string | null;
  current: number | null;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  week: Window;
  month: Window;
  pctRank: number | null;
  slope14d: number | null;
}

export function summarize(series: Point[]): SeriesSummary {
  if (series.length === 0) {
    const empty = rollingWindow([], 0);
    return {
      nDays: 0, firstDate: null, lastDate: null, current: null,
      minimum: null, maximum: null, mean: null,
      week: empty, month: empty, pctRank: null, slope14d: null,
    };
  }

  const values = series.map((p) => p.price);
  const current = values[values.length - 1]!;

  return {
    nDays: series.length,
    firstDate: series[0]!.date,
    lastDate: series[series.length - 1]!.date,
    current,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    mean: round(mean(values)),
    week: rollingWindow(series, 7),
    month: rollingWindow(series, 30),
    pctRank: percentileRank(series, current),
    slope14d: trendSlope(series, 14),
  };
}

/** Unicode sparkline of the most recent `width` points. */
export function sparkline(series: Point[], width = 48): string {
  const blocks = "▁▂▃▄▅▆▇█";
  const values = series.slice(-width).map((p) => p.price);
  if (values.length < 2) return "";

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return blocks[0]!.repeat(values.length);

  return values
    .map((v) => {
      const idx = Math.min(
        Math.floor(((v - lo) / (hi - lo)) * (blocks.length - 1)),
        blocks.length - 1,
      );
      return blocks[idx];
    })
    .join("");
}
