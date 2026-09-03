"""Amadeus Self-Service client — optional corroborating signal.

The Flight Price Analysis endpoint returns historical fare quartiles for a
route/date, which is an independent read on whether today's fare is cheap:

    quartileRanking: MINIMUM / FIRST / MEDIUM / THIRD / MAXIMUM

Entirely optional. If the credentials aren't set, the tracker skips it.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://test.api.amadeus.com"  # switch to api.amadeus.com for production keys
TOKEN_URL = f"{BASE}/v1/security/oauth2/token"
METRICS_URL = f"{BASE}/v1/analytics/itinerary-price-metrics"

_token_cache: dict = {"value": None, "expires_at": 0.0}


class AmadeusError(Exception):
    pass


def is_configured() -> bool:
    return bool(os.environ.get("AMADEUS_CLIENT_ID") and os.environ.get("AMADEUS_CLIENT_SECRET"))


def _token() -> str:
    if _token_cache["value"] and time.time() < _token_cache["expires_at"]:
        return _token_cache["value"]

    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": os.environ["AMADEUS_CLIENT_ID"],
        "client_secret": os.environ["AMADEUS_CLIENT_SECRET"],
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise AmadeusError(f"Amadeus auth failed (HTTP {exc.code}). Check your credentials.") from exc

    _token_cache["value"] = payload["access_token"]
    _token_cache["expires_at"] = time.time() + payload.get("expires_in", 1799) - 60
    return _token_cache["value"]


def price_metrics(origin: str, destination: str, departure_date: str,
                  currency: str = "USD") -> dict | None:
    """Return {'minimum','first','medium','third','maximum'} or None if unavailable.

    Amadeus only has metrics for routes it has enough booking data on, so a
    missing result is normal rather than an error.
    """
    if not is_configured():
        return None

    params = urllib.parse.urlencode({
        "originIataCode": origin,
        "destinationIataCode": destination,
        "departureDate": departure_date,
        "currencyCode": currency,
        "oneWay": "false",
    })
    req = urllib.request.Request(
        f"{METRICS_URL}?{params}",
        headers={"Authorization": f"Bearer {_token()}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError:
        return None
    except (urllib.error.URLError, AmadeusError):
        return None

    data = payload.get("data") or []
    if not data:
        return None

    out = {}
    for item in data[0].get("priceMetrics", []):
        ranking = (item.get("quartileRanking") or "").lower()
        try:
            out[ranking] = float(item["amount"])
        except (KeyError, ValueError, TypeError):
            continue
    return out or None
