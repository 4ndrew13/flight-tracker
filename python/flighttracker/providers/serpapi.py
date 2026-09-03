"""SerpApi Google Flights client.

This is the source of the low/typical/high classification. SerpApi proxies
Google Flights and exposes `price_insights`:

    {
      "lowest_price": 612,
      "price_level": "low" | "typical" | "high",
      "typical_price_range": [570, 1050],
      "price_history": [[unix_ts, price], ...]
    }
"""

from __future__ import annotations

import json
import statistics
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .. import config as config_module
from ..config import Config, Trip, require_key

ENDPOINT = "https://serpapi.com/search.json"
KEY_URL = "https://serpapi.com/manage-api-key"


class ProviderError(Exception):
    pass


def _get(params: dict, timeout: int = 60) -> dict:
    url = f"{ENDPOINT}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "flight-tracker/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        raise ProviderError(f"SerpApi HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise ProviderError(f"Could not reach SerpApi: {exc.reason}") from exc

    if "error" in payload:
        raise ProviderError(f"SerpApi returned an error: {payload['error']}")
    return payload


def _parse_offer(item: dict, is_best: bool) -> dict:
    legs = item.get("flights", [])
    first, last = (legs[0], legs[-1]) if legs else ({}, {})
    return {
        "price": item.get("price"),
        "airline": ", ".join(sorted({leg.get("airline", "") for leg in legs if leg.get("airline")})),
        "flight_numbers": ", ".join(leg.get("flight_number", "") for leg in legs),
        "stops": max(len(legs) - 1, 0),
        "total_duration": item.get("total_duration"),
        "departure_time": (first.get("departure_airport") or {}).get("time"),
        "arrival_time": (last.get("arrival_airport") or {}).get("time"),
        "layovers": [
            {"airport": lay.get("id"), "minutes": lay.get("duration")}
            for lay in item.get("layovers", [])
        ],
        "is_best": is_best,
        "booking_token": item.get("booking_token"),
    }


def fetch(trip: Trip, cfg: Config, save_raw: bool = True) -> dict:
    """Poll Google Flights via SerpApi and normalize into a snapshot dict."""
    api_key = require_key("SERPAPI_KEY", KEY_URL)

    params = {
        "engine": "google_flights",
        "api_key": api_key,
        "departure_id": trip.origin,
        "arrival_id": trip.destination,
        "outbound_date": trip.outbound_date,
        "type": trip.trip_type,
        "currency": cfg.currency,
        "hl": "en",
        "gl": "us",
        "travel_class": cfg.travel_class,
        "stops": cfg.stops,
        "deep_search": "true",  # match what google.com/travel/flights actually shows
        **{k: v for k, v in cfg.passengers.items() if v},
    }
    if trip.return_date:
        params["return_date"] = trip.return_date

    payload = _get(params)

    raw_path = None
    if save_raw:
        raw_dir = config_module.RAW_DIR
        raw_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = raw_dir / f"{trip.route_id}_{stamp}.json"
        target.write_text(json.dumps(payload, indent=2))
        raw_path = str(Path(target).relative_to(raw_dir.parents[1]))

    best = payload.get("best_flights") or []
    other = payload.get("other_flights") or []
    offers = [_parse_offer(i, True) for i in best] + [_parse_offer(i, False) for i in other]
    prices = [o["price"] for o in offers if isinstance(o.get("price"), (int, float))]

    insights = payload.get("price_insights") or {}
    typical = insights.get("typical_price_range") or [None, None]

    if not prices and not insights:
        raise ProviderError(
            f"No flights and no price insights returned for {trip.route_id}. "
            "Check the airport codes and that the dates are within the airlines' "
            "bookable window (usually ~11 months out)."
        )

    return {
        "provider": "serpapi_google_flights",
        "route_id": trip.route_id,
        "trip_id": trip.id,
        "origin": trip.origin,
        "destination": trip.destination,
        "outbound_date": trip.outbound_date,
        "return_date": trip.return_date,
        "currency": cfg.currency,
        "lowest_price": insights.get("lowest_price") or (min(prices) if prices else None),
        "avg_price": round(statistics.fmean(prices), 2) if prices else None,
        "median_price": round(statistics.median(prices), 2) if prices else None,
        "n_offers": len(prices),
        "price_level": insights.get("price_level"),
        "typical_low": typical[0] if len(typical) == 2 else None,
        "typical_high": typical[1] if len(typical) == 2 else None,
        "price_history": insights.get("price_history") or [],
        "offers": offers,
        "raw_path": raw_path,
    }


def history_points(snapshot: dict) -> list[tuple[str, int]]:
    """Convert Google's price_history [[unix_ts, price], ...] to (date, price)."""
    points = []
    for entry in snapshot.get("price_history", []):
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            continue
        ts, price = entry
        try:
            date = datetime.fromtimestamp(int(ts), tz=timezone.utc).date().isoformat()
            points.append((date, int(price)))
        except (ValueError, TypeError, OSError):
            continue
    return points
