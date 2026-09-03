"""The buy indicator.

Each input is scored on a -1.0 (wait) .. +1.0 (buy) scale, then combined as a
weighted average into a -100..+100 score. Components with no data are dropped
and the remaining weights are renormalized, so the model degrades gracefully
on day one instead of silently scoring missing data as neutral.

Components
  google_price_level      Google's low/typical/high call on today's fare
  typical_range_position  where today's fare sits inside the typical band
  history_percentile      how today's fare ranks against every price we've logged
  momentum_7d             7-day rolling avg vs the 7 days before it
  momentum_30d            30-day rolling avg vs the 30 days before it
  deadline_pressure       the booking curve — how much runway is left

Sign convention for momentum: rising prices push *toward* buying (the window is
closing), falling prices push toward waiting (the trend is your friend).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from .stats import SeriesSummary

BUY_NOW = "BUY NOW"
BUY_SOON = "BUY SOON"
HOLD = "HOLD"
WAIT = "WAIT"
STRONG_WAIT = "KEEP WAITING"

ACTION_BLURB = {
    BUY_NOW: "Book today. Conditions are as good as they are likely to get.",
    BUY_SOON: "Start watching daily and be ready to book within a week or two.",
    HOLD: "Nothing decisive either way. Keep collecting data.",
    WAIT: "No reason to book yet. Prices have room to come down.",
    STRONG_WAIT: "Do not book. It is early and the trend favors waiting.",
}


@dataclass
class Component:
    name: str
    score: float          # -1.0 .. +1.0
    weight: float
    reason: str

    @property
    def contribution(self) -> float:
        return self.score * self.weight


@dataclass
class Verdict:
    action: str
    score: float
    confidence: str
    components: list[Component] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    target_price: float | None = None
    days_to_departure: int | None = None

    @property
    def blurb(self) -> str:
        return ACTION_BLURB.get(self.action, "")


def _clamp(value: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def deadline_pressure(days_out: int) -> tuple[float, str]:
    """The booking curve for international leisure routes.

    Very early, fares are placeholder-ish and usually fall. The prime window
    for Caribbean travel is roughly 2-4 months out. Inside ~3 weeks, fares on
    a peak-season route essentially only go up.
    """
    if days_out > 180:
        return -0.6, f"{days_out} days out — very early; fares typically still soften from here"
    if days_out > 120:
        return -0.3, f"{days_out} days out — still early; the prime booking window hasn't opened"
    if days_out > 90:
        return 0.0, f"{days_out} days out — approaching the prime booking window"
    if days_out > 60:
        return 0.35, f"{days_out} days out — inside the prime booking window"
    if days_out > 21:
        return 0.7, f"{days_out} days out — prime window closing, fares usually climb from here"
    if days_out > 14:
        return 0.9, f"only {days_out} days out — last-minute pricing is taking over"
    return 1.0, f"only {days_out} days out — fares now move one direction"


def _price_level_component(level: str | None, weight: float) -> Component | None:
    if not level:
        return None
    mapping = {
        "low": (1.0, "Google rates this fare LOW for the route — a genuine buy signal"),
        "typical": (0.0, "Google rates this fare TYPICAL — no edge either way"),
        "high": (-0.8, "Google rates this fare HIGH — you are paying a premium right now"),
    }
    score, reason = mapping.get(level.lower(), (0.0, f"Google price level: {level}"))
    return Component("google_price_level", score, weight, reason)


def _typical_range_component(price: float | None, lo: int | None, hi: int | None,
                             weight: float) -> Component | None:
    if price is None or lo is None or hi is None or hi <= lo:
        return None
    position = (price - lo) / (hi - lo)
    score = _clamp(1.0 - 2.0 * position)
    if position <= 0:
        reason = f"${price:,.0f} is below the typical band (${lo:,}-${hi:,})"
    elif position >= 1:
        reason = f"${price:,.0f} is above the typical band (${lo:,}-${hi:,})"
    else:
        reason = (f"${price:,.0f} sits at the {position * 100:.0f}% mark of the "
                  f"typical band (${lo:,}-${hi:,})")
    return Component("typical_range_position", score, weight, reason)


def _history_component(summary: SeriesSummary, weight: float) -> Component | None:
    if summary.pct_rank is None or summary.n_days < 5:
        return None
    score = _clamp(2.0 * summary.pct_rank - 1.0)
    cheaper_than = summary.pct_rank * 100
    reason = (f"cheaper than {cheaper_than:.0f}% of the {summary.n_days} daily prices "
              f"logged (range ${summary.minimum:,.0f}-${summary.maximum:,.0f})")
    return Component("history_percentile", score, weight, reason)


def _momentum_component(window, weight: float, name: str,
                        full_scale_pct: float) -> Component | None:
    pct = window.delta_pct
    if pct is None or window.previous_n < 2:
        return None
    score = _clamp(pct / full_scale_pct)
    label = f"{window.days}-day"
    if window.direction == "rising":
        reason = (f"{label} average is up {pct:+.1f}% vs the prior {window.days} days "
                  f"(${window.previous_avg:,.0f} → ${window.current_avg:,.0f}) — waiting is costing you")
    elif window.direction == "falling":
        reason = (f"{label} average is down {pct:+.1f}% vs the prior {window.days} days "
                  f"(${window.previous_avg:,.0f} → ${window.current_avg:,.0f}) — the trend favors waiting")
    else:
        reason = f"{label} average is flat ({pct:+.1f}%) — no momentum either way"
    return Component(name, score, weight, reason)


def _confidence(summary: SeriesSummary, has_insights: bool) -> str:
    if summary.n_days >= 21 and has_insights:
        return "high"
    if summary.n_days >= 7:
        return "medium"
    return "low"


def evaluate(
    *,
    current_price: float | None,
    summary: SeriesSummary,
    price_level: str | None,
    typical_low: int | None,
    typical_high: int | None,
    departure_date: str,
    weights: dict,
    thresholds: dict,
    as_of: date | None = None,
    amadeus_metrics: dict | None = None,
) -> Verdict:
    as_of = as_of or date.today()
    days_out = (date.fromisoformat(departure_date) - as_of).days

    components: list[Component] = []
    notes: list[str] = []

    for comp in (
        _price_level_component(price_level, weights["google_price_level"]),
        _typical_range_component(current_price, typical_low, typical_high,
                                 weights["typical_range_position"]),
        _history_component(summary, weights["history_percentile"]),
        _momentum_component(summary.week, weights["momentum_7d"], "momentum_7d", 5.0),
        _momentum_component(summary.month, weights["momentum_30d"], "momentum_30d", 8.0),
    ):
        if comp is not None:
            components.append(comp)

    pressure_score, pressure_reason = deadline_pressure(days_out)
    components.append(
        Component("deadline_pressure", pressure_score,
                  weights["deadline_pressure"], pressure_reason)
    )

    # A "wait" signal is only worth acting on if there is time left to act on
    # it. As the departure closes in, damp the wait-leaning components — the
    # hotel is booked, so "don't fly" was never one of the options.
    runway = _clamp(days_out / 60.0, 0.15, 1.0)
    total_weight = sum(c.weight for c in components)
    raw = 0.0
    for comp in components:
        contribution = comp.contribution
        if contribution < 0 and comp.name != "deadline_pressure":
            contribution *= runway
        raw += contribution
    score = round(raw / total_weight * 100, 1) if total_weight else 0.0
    if runway < 1.0:
        notes.append(f"With {days_out} days left, wait signals are damped to "
                     f"{runway * 100:.0f}% — there is limited runway for a better price.")

    # --- Amadeus cross-check (advisory only; does not move the score) ---
    if amadeus_metrics and current_price:
        first = amadeus_metrics.get("first")
        median = amadeus_metrics.get("medium")
        if first and current_price <= first:
            notes.append(f"Amadeus: ${current_price:,.0f} is in the cheapest 25% of "
                         f"historical fares for this route (Q1 = ${first:,.0f}).")
        elif median and current_price > median:
            notes.append(f"Amadeus: ${current_price:,.0f} is above the historical median "
                         f"(${median:,.0f}) for this route.")

    action = _action_for(score, thresholds)

    # --- Overrides -------------------------------------------------------
    # Booking this far out is rarely optimal, however good today's number looks.
    if days_out > 200 and action == BUY_NOW:
        action = BUY_SOON
        notes.append("Capped at BUY SOON: it is more than 200 days out, and fares this "
                     "early are usually beatable.")

    # Out of runway. Past a certain point "wait" stops being a real option:
    # you have a hotel booked, so the only question is how much you pay.
    if days_out <= 10:
        if action not in (BUY_NOW,):
            action = BUY_NOW
            notes.append(f"Override: {days_out} days out. There is no meaningful "
                         "upside left in waiting — book the best option available.")
    # Either window rising counts: a flat week inside a strongly rising month is
    # still a closing window, and this close in there's no time to wait it out.
    elif days_out <= 21 and "rising" in (summary.week.direction, summary.month.direction):
        if action in (HOLD, WAIT, STRONG_WAIT):
            action = BUY_NOW if days_out <= 14 else BUY_SOON
            notes.append(f"Override: {days_out} days out with prices still rising. "
                         "Waiting has a poor expected value this close in.")

    # A record low that Google also calls cheap, with the window closing, is a buy.
    is_record_low = (
        current_price is not None
        and summary.minimum is not None
        and summary.n_days >= 10
        and current_price <= summary.minimum
    )
    if is_record_low and (price_level or "").lower() == "low" and days_out <= 150:
        if action not in (BUY_NOW,):
            action = BUY_NOW
            notes.append("Override: this is the lowest price logged so far AND Google "
                         "rates it low, with the booking window open.")

    if summary.n_days < 5:
        notes.append(f"Only {summary.n_days} day(s) of price history so far. The trend "
                     "components are still dark — treat this verdict as provisional.")

    return Verdict(
        action=action,
        score=score,
        confidence=_confidence(summary, price_level is not None),
        components=components,
        notes=notes,
        target_price=_target_price(summary, typical_low),
        days_to_departure=days_out,
    )


def _action_for(score: float, thresholds: dict) -> str:
    if score >= thresholds["buy_now"]:
        return BUY_NOW
    if score >= thresholds["buy_soon"]:
        return BUY_SOON
    if score >= thresholds["hold"]:
        return HOLD
    if score >= thresholds["wait"]:
        return WAIT
    return STRONG_WAIT


def _target_price(summary: SeriesSummary, typical_low: int | None) -> float | None:
    """A concrete 'book it without thinking' trigger price.

    The lower of Google's typical-band floor and the 25th percentile of what
    we have actually observed.
    """
    candidates = [float(typical_low)] if typical_low else []
    if summary.minimum is not None and summary.mean is not None and summary.n_days >= 5:
        candidates.append(round(summary.minimum + (summary.mean - summary.minimum) * 0.25, 2))
    return min(candidates) if candidates else None
