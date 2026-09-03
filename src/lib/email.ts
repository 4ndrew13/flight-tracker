/**
 * Daily digest email.
 *
 * Hand-written table layout with inline styles — email clients have poor
 * support for flexbox/grid and strip <style> blocks, so this avoids both.
 * Sent to one address (you); forward it to whoever else cares.
 *
 * Uses fetch against the Resend REST API rather than their SDK, which keeps
 * this project at zero runtime dependencies.
 */

import { cityFor, describeAirport } from "./airports.ts";
import { formatDatePretty, formatDateRange } from "./dates.ts";
import { ACTIONS, type Action, type Verdict } from "./signal.ts";
import type { Offer } from "./serpapi.ts";
import type { SeriesSummary } from "./stats.ts";

export interface RouteReport {
  tripId: string;
  tripLabel: string;
  origin: string;
  destination: string;
  outboundDate: string;
  returnDate: string | null;
  currency: string;
  summary: SeriesSummary;
  verdict: Verdict;
  priceLevel: string | null;
  typicalLow: number | null;
  typicalHigh: number | null;
  offers: Offer[];
  stale?: boolean;
}

const ACTION_STYLE: Record<Action, { bg: string; fg: string; border: string }> = {
  [ACTIONS.BUY_NOW]: { bg: "#e7f6ed", fg: "#0f7b3f", border: "#9dd5b4" },
  [ACTIONS.BUY_SOON]: { bg: "#e6f4f6", fg: "#0b6b75", border: "#9ccfd6" },
  [ACTIONS.HOLD]: { bg: "#fdf3e0", fg: "#8a6100", border: "#e8ca8e" },
  [ACTIONS.WAIT]: { bg: "#f0eef8", fg: "#4b3f8f", border: "#c3b9e6" },
  [ACTIONS.STRONG_WAIT]: { bg: "#fbeceb", fg: "#a3312a", border: "#e8b3af" },
};

// Ranked most to least urgent — drives card order within a trip.
const URGENCY: Action[] = [
  ACTIONS.BUY_NOW, ACTIONS.BUY_SOON, ACTIONS.HOLD, ACTIONS.WAIT, ACTIONS.STRONG_WAIT,
];

const FONT = "-apple-system,Segoe UI,Roboto,sans-serif";

function money(value: number | null, currency = "USD"): string {
  if (value === null || Number.isNaN(value)) return "—";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${Math.round(value).toLocaleString("en-US")}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function trendCell(
  label: string,
  window: { currentAvg: number | null; deltaPct: number | null; direction: string },
  currency: string,
): string {
  if (window.currentAvg === null) {
    return `<td style="padding:8px 12px;font:14px ${FONT};color:#8b8b8b;">${label}: not enough data</td>`;
  }
  const delta = window.deltaPct;
  let badge = `<span style="color:#8b8b8b;">no prior window</span>`;
  if (delta !== null) {
    const rising = window.direction === "rising";
    const falling = window.direction === "falling";
    const color = rising ? "#a3312a" : falling ? "#0f7b3f" : "#8a6100";
    const arrow = rising ? "▲" : falling ? "▼" : "▬";
    badge = `<span style="color:${color};font-weight:600;">${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%</span>`;
  }
  return `<td style="padding:8px 12px;font:14px ${FONT};color:#333;">
    <span style="color:#6b6b6b;">${label}</span><br>
    <strong style="font-size:16px;">${money(window.currentAvg, currency)}</strong> ${badge}
  </td>`;
}

function renderRouteCard(report: RouteReport): string {
  const { verdict, summary, currency } = report;
  const style = ACTION_STYLE[verdict.action];

  const level = report.priceLevel?.toLowerCase();
  const levelBadge = report.priceLevel
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700;letter-spacing:.04em;background:${
        level === "low" ? "#e7f6ed" : level === "high" ? "#fbeceb" : "#fdf3e0"
      };color:${
        level === "low" ? "#0f7b3f" : level === "high" ? "#a3312a" : "#8a6100"
      };">GOOGLE: ${escapeHtml(report.priceLevel.toUpperCase())}</span>`
    : "";

  const reasons = [...verdict.components]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map((c) => {
      const mark = c.contribution > 0 ? "▲" : c.contribution < 0 ? "▼" : "•";
      const color = c.contribution > 0 ? "#0f7b3f" : c.contribution < 0 ? "#a3312a" : "#8b8b8b";
      return `<tr><td style="padding:4px 0;font:13px ${FONT};color:#444;vertical-align:top;">
        <span style="color:${color};font-weight:700;">${mark}</span> ${escapeHtml(c.reason)}
      </td></tr>`;
    })
    .join("");

  const offerRows = report.offers.slice(0, 3).map((o) => {
    const stops = o.stops === 0 ? "nonstop" : `${o.stops} stop${o.stops > 1 ? "s" : ""}`;
    const dur = o.totalDuration ? `${Math.floor(o.totalDuration / 60)}h ${o.totalDuration % 60}m` : "";
    return `<tr>
      <td style="padding:6px 0;font:13px ${FONT};color:#111;font-weight:700;">${money(o.price, currency)}</td>
      <td style="padding:6px 8px;font:13px ${FONT};color:#444;">${escapeHtml(o.airline || "—")}</td>
      <td style="padding:6px 0;font:13px ${FONT};color:#6b6b6b;">${stops} · ${dur}</td>
    </tr>`;
  }).join("");

  const staleFlag = report.stale
    ? `<div style="font:12px ${FONT};color:#8a6100;padding-top:4px;">Not refreshed today — showing the last successful reading.</div>`
    : "";

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e3e3;border-radius:10px;margin:0 0 14px;background:#ffffff;">
    <tr><td style="padding:16px 20px 0;">
      <div style="font:600 16px ${FONT};color:#111;">${escapeHtml(describeAirport(report.origin))}</div>
      ${staleFlag}
    </td></tr>
    <tr><td style="padding:12px 20px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${style.bg};border:1px solid ${style.border};border-radius:8px;">
        <tr><td style="padding:12px 14px;">
          <div style="font:800 20px ${FONT};color:${style.fg};letter-spacing:.02em;">${escapeHtml(verdict.action)}</div>
          <div style="font:14px ${FONT};color:#333;padding-top:3px;">${escapeHtml(verdict.blurb)}</div>
          <div style="font:12px ${FONT};color:#6b6b6b;padding-top:5px;">
            score ${verdict.score > 0 ? "+" : ""}${verdict.score.toFixed(1)}/100 · confidence ${verdict.confidence}
          </div>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:14px 20px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font:13px ${FONT};color:#6b6b6b;">Cheapest today</td>
          <td align="right" style="font:800 23px ${FONT};color:#111;">${money(summary.current, currency)}</td>
        </tr>
        ${report.priceLevel ? `<tr><td colspan="2" style="padding-top:8px;">${levelBadge}</td></tr>` : ""}
        ${report.typicalLow && report.typicalHigh ? `<tr><td colspan="2" style="padding-top:8px;font:13px ${FONT};color:#6b6b6b;">Typical range ${money(report.typicalLow, currency)} – ${money(report.typicalHigh, currency)}</td></tr>` : ""}
      </table>
    </td></tr>
    <tr><td style="padding:12px 8px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;">
        <tr>
          ${trendCell("7-day avg", summary.week, currency)}
          ${trendCell("30-day avg", summary.month, currency)}
        </tr>
      </table>
    </td></tr>
    ${reasons ? `<tr><td style="padding:10px 20px 0;">
      <div style="font:600 12px ${FONT};color:#8b8b8b;letter-spacing:.06em;padding-bottom:4px;">WHY</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${reasons}</table>
    </td></tr>` : ""}
    ${verdict.targetPrice ? `<tr><td style="padding:12px 20px 0;">
      <div style="background:#f6f6f4;border-radius:6px;padding:9px 12px;font:13px ${FONT};color:#333;">
        <strong>Trigger price:</strong> book without hesitating at or below
        <strong style="color:#0f7b3f;">${money(verdict.targetPrice, currency)}</strong>
      </div>
    </td></tr>` : ""}
    ${offerRows ? `<tr><td style="padding:12px 20px 16px;">
      <div style="font:600 12px ${FONT};color:#8b8b8b;letter-spacing:.06em;padding-bottom:4px;">CHEAPEST RIGHT NOW</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${offerRows}</table>
    </td></tr>` : `<tr><td style="padding-bottom:16px;"></td></tr>`}
  </table>`;
}

interface TripGroup {
  tripId: string;
  label: string;
  destination: string;
  outboundDate: string;
  returnDate: string | null;
  reports: RouteReport[];
  best: RouteReport;
}

function groupByTrip(reports: RouteReport[]): TripGroup[] {
  const groups = new Map<string, RouteReport[]>();
  for (const report of reports) {
    const bucket = groups.get(report.tripId) ?? [];
    bucket.push(report);
    groups.set(report.tripId, bucket);
  }

  return [...groups.values()]
    .map((bucket) => {
      const sorted = [...bucket].sort(
        (a, b) =>
          URGENCY.indexOf(a.verdict.action) - URGENCY.indexOf(b.verdict.action) ||
          (a.summary.current ?? Infinity) - (b.summary.current ?? Infinity),
      );
      const head = sorted[0]!;
      return {
        tripId: head.tripId,
        label: head.tripLabel,
        destination: head.destination,
        outboundDate: head.outboundDate,
        returnDate: head.returnDate,
        reports: sorted,
        best: head,
      };
    })
    // Soonest departure first — the trip you have to decide about sooner.
    .sort((a, b) => a.outboundDate.localeCompare(b.outboundDate));
}

export function renderDigest(
  reports: RouteReport[],
  notes: string[] = [],
): { subject: string; html: string; text: string } {
  const groups = groupByTrip(reports);

  // "SJU BUY SOON $412 · PUJ WAIT $689" — both trips visible in the inbox.
  const subject = groups
    .map((g) => {
      const cheapest = Math.min(
        ...g.reports.map((r) => r.summary.current ?? Infinity),
      );
      const price = Number.isFinite(cheapest) ? money(cheapest, g.best.currency) : "—";
      return `${g.destination} ${g.best.verdict.action} ${price}`;
    })
    .join(" · ");

  const noteBlock = notes.length
    ? `<tr><td style="padding:0 0 16px;">
         <div style="font:12px/1.5 ${FONT};color:#8a6100;background:#fdf3e0;border:1px solid #e8ca8e;border-radius:8px;padding:10px 12px;">
           ${notes.map((n) => escapeHtml(n)).join("<br>")}
         </div>
       </td></tr>`
    : "";

  const sections = groups
    .map((g) => {
      const city = cityFor(g.destination) ?? g.destination;
      return `
      <tr><td style="padding:6px 0 10px;">
        <div style="font:800 18px ${FONT};color:#111;">${escapeHtml(city)}</div>
        <div style="font:13px ${FONT};color:#6b6b6b;padding-top:2px;">
          ${escapeHtml(formatDateRange(g.outboundDate, g.returnDate))} · ${g.best.verdict.daysToDeparture} days out
        </div>
      </td></tr>
      <tr><td>${g.reports.map(renderRouteCard).join("")}</td></tr>
      <tr><td style="padding-bottom:14px;"></td></tr>`;
    })
    .join("");

  const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="padding:0 0 18px;">
        <div style="font:800 20px ${FONT};color:#111;">Flight watch</div>
        <div style="font:13px ${FONT};color:#6b6b6b;padding-top:3px;">
          Daily price check · ${formatDatePretty(new Date().toISOString().slice(0, 10))}
        </div>
      </td></tr>
      ${noteBlock}
      ${sections}
    </table>
  </td></tr>
</table>`.trim();

  const textLines: string[] = ["Flight watch", ""];
  for (const note of notes) textLines.push(`! ${note}`);
  if (notes.length) textLines.push("");

  for (const g of groups) {
    const city = cityFor(g.destination) ?? g.destination;
    textLines.push(
      `${city.toUpperCase()} — ${formatDateRange(g.outboundDate, g.returnDate)} (${g.best.verdict.daysToDeparture} days out)`,
      "",
    );
    for (const r of g.reports) {
      textLines.push(
        `  ${describeAirport(r.origin)}${r.stale ? " [stale]" : ""}`,
        `    ${r.verdict.action} — score ${r.verdict.score.toFixed(1)}/100, confidence ${r.verdict.confidence}`,
        `    Cheapest today: ${money(r.summary.current, r.currency)}${r.priceLevel ? ` (Google: ${r.priceLevel.toUpperCase()})` : ""}`,
      );
      for (const c of [...r.verdict.components]
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 3)) {
        textLines.push(`      - ${c.reason}`);
      }
      if (r.verdict.targetPrice) {
        textLines.push(`    Trigger price: ${money(r.verdict.targetPrice, r.currency)}`);
      }
      textLines.push("");
    }
  }

  return { subject, html, text: textLines.join("\n") };
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Send the digest via the Resend REST API.
 *
 * With no verified domain, Resend's shared sender (onboarding@resend.dev) can
 * only deliver to the address on your own Resend account — which is exactly
 * this single-recipient case. Verify a domain later and set EMAIL_FROM to an
 * address on it to send anywhere.
 */
export async function sendDigest(
  subject: string,
  html: string,
  text: string,
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set" };

  const to = process.env.EMAIL_TO;
  if (!to) return { ok: false, error: "EMAIL_TO is not set" };

  const from = process.env.EMAIL_FROM || "Flight Watch <onboarding@resend.dev>";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      return { ok: false, error: `Resend HTTP ${response.status}: ${body}` };
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
}
