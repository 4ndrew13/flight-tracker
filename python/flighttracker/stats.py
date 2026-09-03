"""Rolling-window statistics over the daily price series."""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date, timedelta


def _to_date(value: str) -> date:
    return date.fromisoformat(value)


@dataclass
class Window:
    """A rolling window and the window immediately before it."""

    days: int
    current_avg: float | None
    previous_avg: float | None
    current_n: int
    previous_n: int

    @property
    def delta_abs(self) -> float | None:
        if self.current_avg is None or self.previous_avg is None:
            return None
        return self.current_avg - self.previous_avg

    @property
    def delta_pct(self) -> float | None:
        if self.current_avg is None or not self.previous_avg:
            return None
        return (self.current_avg - self.previous_avg) / self.previous_avg * 100.0

    @property
    def direction(self) -> str:
        pct = self.delta_pct
        if pct is None:
            return "unknown"
        if pct > 1.5:
            return "rising"
        if pct < -1.5:
            return "falling"
        return "flat"


def rolling_window(series: list[tuple[str, float]], days: int,
                   as_of: date | None = None) -> Window:
    """Mean over the last `days`, and the mean over the `days` before that."""
    if not series:
        return Window(days, None, None, 0, 0)

    as_of = as_of or _to_date(series[-1][0])
    cur_start = as_of - timedelta(days=days - 1)
    prev_start = cur_start - timedelta(days=days)

    current = [v for d, v in series if cur_start <= _to_date(d) <= as_of]
    previous = [v for d, v in series if prev_start <= _to_date(d) < cur_start]

    return Window(
        days=days,
        current_avg=round(statistics.fmean(current), 2) if current else None,
        previous_avg=round(statistics.fmean(previous), 2) if previous else None,
        current_n=len(current),
        previous_n=len(previous),
    )


def percentile_rank(series: list[tuple[str, float]], value: float) -> float | None:
    """Fraction of observed prices that are *higher* than `value` (0.0-1.0).

    1.0 means this is the cheapest price we have ever seen for the route.
    """
    values = [v for _, v in series]
    if len(values) < 2:
        return None
    higher = sum(1 for v in values if v > value)
    return higher / len(values)


def trend_slope(series: list[tuple[str, float]], days: int = 14) -> float | None:
    """Least-squares slope in currency units per day over the recent window."""
    if len(series) < 3:
        return None
    recent = series[-days:]
    if len(recent) < 3:
        return None

    origin = _to_date(recent[0][0])
    xs = [(_to_date(d) - origin).days for d, _ in recent]
    ys = [v for _, v in recent]
    n = len(xs)
    mean_x = statistics.fmean(xs)
    mean_y = statistics.fmean(ys)
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom == 0:
        return None
    return round(sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom, 2)


@dataclass
class SeriesSummary:
    n_days: int
    first_date: str | None
    last_date: str | None
    current: float | None
    minimum: float | None
    maximum: float | None
    mean: float | None
    week: Window
    month: Window
    pct_rank: float | None
    slope_14d: float | None

    @property
    def span_days(self) -> int:
        if not self.first_date or not self.last_date:
            return 0
        return (_to_date(self.last_date) - _to_date(self.first_date)).days + 1


def summarize(series: list[tuple[str, float]]) -> SeriesSummary:
    if not series:
        empty = Window(0, None, None, 0, 0)
        return SeriesSummary(0, None, None, None, None, None, None, empty, empty, None, None)

    values = [v for _, v in series]
    current = values[-1]
    return SeriesSummary(
        n_days=len(series),
        first_date=series[0][0],
        last_date=series[-1][0],
        current=current,
        minimum=min(values),
        maximum=max(values),
        mean=round(statistics.fmean(values), 2),
        week=rolling_window(series, 7),
        month=rolling_window(series, 30),
        pct_rank=percentile_rank(series, current),
        slope_14d=trend_slope(series, 14),
    )


def sparkline(series: list[tuple[str, float]], width: int = 48) -> str:
    """Unicode sparkline of the most recent `width` points."""
    blocks = "▁▂▃▄▅▆▇█"
    values = [v for _, v in series][-width:]
    if len(values) < 2:
        return ""
    lo, hi = min(values), max(values)
    if hi == lo:
        return blocks[0] * len(values)
    return "".join(blocks[min(int((v - lo) / (hi - lo) * (len(blocks) - 1)), len(blocks) - 1)]
                   for v in values)
