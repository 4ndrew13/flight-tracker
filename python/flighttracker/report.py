"""Terminal report rendering."""

from __future__ import annotations

import os
import sys

from .signal import BUY_NOW, BUY_SOON, HOLD, STRONG_WAIT, WAIT, Verdict
from .stats import SeriesSummary, sparkline

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

C = {
    "reset": "\033[0m", "bold": "\033[1m", "dim": "\033[2m",
    "green": "\033[32m", "yellow": "\033[33m", "red": "\033[31m",
    "cyan": "\033[36m", "magenta": "\033[35m",
}

ACTION_COLOR = {
    BUY_NOW: "green", BUY_SOON: "cyan", HOLD: "yellow",
    WAIT: "magenta", STRONG_WAIT: "red",
}


def c(text: str, *styles: str) -> str:
    if not _USE_COLOR:
        return text
    return "".join(C[s] for s in styles if s in C) + text + C["reset"]


def _rule(char: str = "─", width: int = 74) -> str:
    return c(char * width, "dim")


def _money(value, currency: str = "USD") -> str:
    if value is None:
        return "—"
    symbol = "$" if currency == "USD" else f"{currency} "
    return f"{symbol}{value:,.0f}"


def _arrow(direction: str) -> str:
    return {"rising": "▲", "falling": "▼", "flat": "▬"}.get(direction, "?")


def _window_line(label: str, window, currency: str) -> str:
    if window.current_avg is None:
        return f"  {label:<22} {c('not enough data yet', 'dim')}"
    if window.delta_pct is None:
        return (f"  {label:<22} {_money(window.current_avg, currency):>9}   "
                f"{c('(no prior window to compare)', 'dim')}")

    color = "red" if window.direction == "rising" else "green" if window.direction == "falling" else "yellow"
    delta = f"{_arrow(window.direction)} {window.delta_pct:+.1f}%"
    return (f"  {label:<22} {_money(window.current_avg, currency):>9}   "
            f"{c(delta, color, 'bold'):<20} "
            f"{c(f'prior: {_money(window.previous_avg, currency)}', 'dim')}")


def render(
    *,
    trip_label: str,
    route: str,
    currency: str,
    summary: SeriesSummary,
    avg_summary: SeriesSummary,
    verdict: Verdict,
    price_level: str | None,
    typical_low: int | None,
    typical_high: int | None,
    series: list[tuple[str, float]],
    offers: list,
) -> str:
    out: list[str] = []
    add = out.append

    add("")
    add(_rule("═"))
    add(f" {c(trip_label, 'bold')}   {c(route, 'dim')}")
    add(_rule("═"))

    # --- Verdict banner ---
    color = ACTION_COLOR.get(verdict.action, "yellow")
    add("")
    add(f"  {c(f'  {verdict.action}  ', color, 'bold')}   "
        f"score {c(f'{verdict.score:+.1f}', 'bold')}/100   "
        f"confidence: {verdict.confidence}")
    add(f"  {c(verdict.blurb, 'dim')}")
    if verdict.days_to_departure is not None:
        add(f"  {c(f'{verdict.days_to_departure} days until departure', 'dim')}")
    add("")

    # --- Today ---
    add(_rule())
    add(f" {c('TODAY', 'bold')}")
    add(f"  {'Cheapest fare':<22} {c(_money(summary.current, currency), 'bold'):>9}")
    if avg_summary.current is not None:
        add(f"  {'Average of all fares':<22} {_money(avg_summary.current, currency):>9}")
    if price_level:
        lvl_color = {"low": "green", "typical": "yellow", "high": "red"}.get(price_level.lower(), "yellow")
        add(f"  {'Google rates it':<22} {c(price_level.upper(), lvl_color, 'bold'):>9}")
    if typical_low and typical_high:
        add(f"  {'Typical range':<22} "
            f"{_money(typical_low, currency)} – {_money(typical_high, currency)}")

    # --- Trends ---
    add("")
    add(_rule())
    add(f" {c('TRENDS (cheapest fare per day)', 'bold')}")
    add(_window_line("7-day average", summary.week, currency))
    add(_window_line("30-day average", summary.month, currency))
    if summary.slope_14d is not None:
        direction = "rising" if summary.slope_14d > 0 else "falling"
        col = "red" if summary.slope_14d > 0 else "green"
        add(f"  {'14-day slope':<22} "
            f"{c(f'{summary.slope_14d:+.2f}/day', col)} ({direction})")

    if avg_summary.week.current_avg is not None:
        add("")
        add(f" {c('TRENDS (average of all fares per day)', 'bold')}")
        add(_window_line("7-day average", avg_summary.week, currency))
        add(_window_line("30-day average", avg_summary.month, currency))

    # --- History ---
    if summary.n_days >= 2:
        add("")
        add(_rule())
        add(f" {c('HISTORY', 'bold')}  "
            f"{c(f'{summary.n_days} daily points, {summary.first_date} → {summary.last_date}', 'dim')}")
        spark = sparkline(series)
        if spark:
            add(f"  {c(spark, 'cyan')}")
            add(f"  {c(f'{_money(min(v for _, v in series[-48:]), currency)}', 'dim')}"
                f"{' ' * max(len(spark) - 12, 1)}"
                f"{c(f'{_money(max(v for _, v in series[-48:]), currency)}', 'dim')}")
        add(f"  {'Low / mean / high':<22} "
            f"{_money(summary.minimum, currency)} / {_money(summary.mean, currency)} / "
            f"{_money(summary.maximum, currency)}")
        if summary.pct_rank is not None:
            add(f"  {'Today ranks':<22} cheaper than "
                f"{c(f'{summary.pct_rank * 100:.0f}%', 'bold')} of logged days")

    # --- Why ---
    add("")
    add(_rule())
    add(f" {c('WHY', 'bold')}")
    for comp in sorted(verdict.components, key=lambda x: -abs(x.contribution)):
        sign = "＋" if comp.contribution > 0 else "－" if comp.contribution < 0 else "·"
        col = "green" if comp.contribution > 0 else "red" if comp.contribution < 0 else "dim"
        add(f"  {c(sign, col)} {c(f'{comp.contribution:+6.1f}', col)}  {comp.reason}")

    for note in verdict.notes:
        add(f"  {c('!', 'yellow')} {c(note, 'dim')}")

    if verdict.target_price:
        add("")
        add(f"  {c('Trigger price:', 'bold')} book without hesitating at or below "
            f"{c(_money(verdict.target_price, currency), 'green', 'bold')}")

    # --- Cheapest options ---
    if offers:
        add("")
        add(_rule())
        add(f" {c('CHEAPEST OPTIONS RIGHT NOW', 'bold')}")
        for offer in offers:
            stops = "nonstop" if offer["stops"] == 0 else f"{offer['stops']} stop(s)"
            dur = offer["total_duration"] or 0
            add(f"  {_money(offer['price'], currency):>8}  "
                f"{(offer['airline'] or '?')[:26]:<26} {stops:<10} "
                f"{c(f'{dur // 60}h {dur % 60}m', 'dim')}")

    add("")
    add(_rule("═"))
    add("")
    return "\n".join(out)
