#!/usr/bin/env python3
"""Emit parity fixtures: the Python engine's verdicts on synthetic series.

The TypeScript port in src/lib/ is asserted against these in test/parity.test.ts,
so the two engines can't silently drift apart.

    python3 python/gen_fixtures.py > test/fixtures/parity.json
"""

import json
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from flighttracker import signal, stats
from flighttracker.config import DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS

AS_OF = date(2026, 7, 31)


def make_series(n_days, start_price, drift, noise, seed):
    random.seed(seed)
    out = []
    for i in range(n_days):
        d = AS_OF - timedelta(days=n_days - 1 - i)
        price = start_price + drift * i + random.gauss(0, noise)
        out.append({"date": d.isoformat(), "price": round(max(price, 120), 2)})
    return out


SCENARIOS = [
    ("early_high_rising", 60, 700, 1.2, 25, "high", [520, 980], 225, 7),
    ("prime_window_record_low", 45, 900, -3.0, 20, "low", [600, 1100], 75, 7),
    ("prime_window_flat_typical", 40, 780, 0.05, 18, "typical", [640, 1020], 80, 7),
    ("close_in_rising_fast", 50, 600, 4.0, 22, "high", [500, 900], 18, 7),
    ("cold_start_two_days", 2, 850, 0, 5, "typical", [600, 1100], 150, 7),
    ("no_price_insights", 30, 820, -1.0, 20, None, [None, None], 95, 7),
    ("out_of_runway_8_days", 40, 640, 2.0, 15, "high", [500, 900], 8, 11),
    ("very_far_out_260_days", 35, 700, -2.0, 20, "low", [520, 980], 260, 13),
    ("single_point", 1, 900, 0, 0, "typical", [600, 1100], 120, 3),
    ("flat_series_no_variance", 20, 800, 0, 0, "typical", [600, 1000], 100, 5),
]

out = []
for name, n, start, drift, noise, level, typ, days_out, seed in SCENARIOS:
    series = make_series(n, start, drift, noise, seed)
    tuples = [(p["date"], p["price"]) for p in series]
    summary = stats.summarize(tuples)
    departure = (AS_OF + timedelta(days=days_out)).isoformat()

    verdict = signal.evaluate(
        current_price=summary.current,
        summary=summary,
        price_level=level,
        typical_low=typ[0],
        typical_high=typ[1],
        departure_date=departure,
        weights=DEFAULT_WEIGHTS,
        thresholds=DEFAULT_THRESHOLDS,
        as_of=AS_OF,
    )

    out.append({
        "name": name,
        "series": series,
        "priceLevel": level,
        "typicalLow": typ[0],
        "typicalHigh": typ[1],
        "departureDate": departure,
        "asOf": AS_OF.isoformat(),
        "expected": {
            "action": verdict.action,
            "score": verdict.score,
            "confidence": verdict.confidence,
            "daysToDeparture": verdict.days_to_departure,
            "targetPrice": verdict.target_price,
            "nComponents": len(verdict.components),
            "componentNames": sorted(c.name for c in verdict.components),
            "summary": {
                "nDays": summary.n_days,
                "current": summary.current,
                "minimum": summary.minimum,
                "maximum": summary.maximum,
                "mean": summary.mean,
                "pctRank": summary.pct_rank,
                "slope14d": summary.slope_14d,
                "week": {
                    "currentAvg": summary.week.current_avg,
                    "previousAvg": summary.week.previous_avg,
                    "deltaPct": summary.week.delta_pct,
                    "direction": summary.week.direction,
                },
                "month": {
                    "currentAvg": summary.month.current_avg,
                    "previousAvg": summary.month.previous_avg,
                    "deltaPct": summary.month.delta_pct,
                    "direction": summary.month.direction,
                },
            },
        },
    })

print(json.dumps(out, indent=2))
