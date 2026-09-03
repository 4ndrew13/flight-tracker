/** UTC-safe helpers for `YYYY-MM-DD` date strings. */

const DAY_MS = 86_400_000;

export function parseDate(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Invalid date: ${iso}`);
  return Date.UTC(y, m - 1, d);
}

export function toISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toISODate(parseDate(iso) + days * DAY_MS);
}

/** Whole days from `from` to `to`. Negative if `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** "Jan 4 – 11, 2027", collapsing the month/year when they're shared. */
export function formatDateRange(from: string, to: string | null): string {
  if (!to) return formatDatePretty(from);
  const a = new Date(parseDate(from));
  const b = new Date(parseDate(to));
  const opts = { timeZone: "UTC" } as const;
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "short", ...opts });
  const day = (d: Date) => d.toLocaleDateString("en-US", { day: "numeric", ...opts });
  const year = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", ...opts });

  if (year(a) !== year(b)) return `${formatDatePretty(from)} – ${formatDatePretty(to)}`;
  if (month(a) === month(b)) return `${month(a)} ${day(a)} – ${day(b)}, ${year(a)}`;
  return `${month(a)} ${day(a)} – ${month(b)} ${day(b)}, ${year(a)}`;
}

export function formatDatePretty(iso: string): string {
  return new Date(parseDate(iso)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
