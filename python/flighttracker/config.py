"""Configuration loading: .env secrets + config.json trip definitions."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
# Prefer python/.env, fall back to the repo-root .env shared with the TS app.
ENV_PATH = ROOT / ".env" if (ROOT / ".env").exists() else REPO_ROOT / ".env"
CONFIG_PATH = ROOT / "config.json"
DB_PATH = ROOT / "data" / "prices.db"
RAW_DIR = ROOT / "data" / "raw"


class ConfigError(Exception):
    """Raised when config.json or .env is missing something we need."""


def load_env() -> dict[str, str]:
    """Read .env into os.environ without requiring python-dotenv.

    Real environment variables win, so you can override a key for one run.
    """
    if ENV_PATH.exists():
        for raw in ENV_PATH.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    return dict(os.environ)


@dataclass(frozen=True)
class Trip:
    id: str
    label: str
    origin: str
    destination: str
    outbound_date: str
    return_date: str | None = None
    enabled: bool = True

    @property
    def route_id(self) -> str:
        """Stable key for this exact origin/destination/date combination."""
        legs = f"{self.origin}-{self.destination}-{self.outbound_date}"
        return f"{legs}-{self.return_date}" if self.return_date else legs

    @property
    def trip_type(self) -> int:
        """SerpApi `type`: 1 = round trip, 2 = one way."""
        return 1 if self.return_date else 2


@dataclass
class Config:
    currency: str = "USD"
    travel_class: int = 1
    stops: int = 0
    passengers: dict = field(default_factory=lambda: {"adults": 1})
    trips: list[Trip] = field(default_factory=list)
    weights: dict = field(default_factory=dict)
    thresholds: dict = field(default_factory=dict)

    @property
    def enabled_trips(self) -> list[Trip]:
        return [t for t in self.trips if t.enabled]


DEFAULT_WEIGHTS = {
    "google_price_level": 25,
    "typical_range_position": 15,
    "history_percentile": 20,
    "momentum_7d": 15,
    "momentum_30d": 10,
    "deadline_pressure": 15,
}

DEFAULT_THRESHOLDS = {"buy_now": 45, "buy_soon": 25, "hold": -10, "wait": -35}


def load_config(path: Path | None = None) -> Config:
    # Resolved at call time so the paths stay overridable.
    path = path or CONFIG_PATH
    if not path.exists():
        raise ConfigError(f"No config file at {path}")

    data = json.loads(path.read_text())
    trips: list[Trip] = []

    for entry in data.get("trips", []):
        origin = (entry.get("origin") or "").strip().upper()
        if origin in ("", "ORIGIN", "XXX", "___"):
            raise ConfigError(
                f"Trip '{entry.get('id', '?')}' still has the placeholder origin airport.\n"
                f"Edit {path} and set \"origin\" to your departure airport code "
                f"(e.g. \"CLT\", \"JFK\", \"ATL\")."
            )
        trips.append(
            Trip(
                id=entry["id"],
                label=entry.get("label", entry["id"]),
                origin=origin,
                destination=(entry["destination"]).strip().upper(),
                outbound_date=entry["outbound_date"],
                return_date=entry.get("return_date"),
                enabled=entry.get("enabled", True),
            )
        )

    signal = data.get("signal", {})
    return Config(
        currency=data.get("currency", "USD"),
        travel_class=data.get("travel_class", 1),
        stops=data.get("stops", 0),
        passengers=data.get("passengers", {"adults": 1}),
        trips=trips,
        weights={**DEFAULT_WEIGHTS, **signal.get("weights", {})},
        thresholds={**DEFAULT_THRESHOLDS, **signal.get("thresholds", {})},
    )


def require_key(name: str, help_url: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"{name} is not set.\n"
            f"  1. cp .env.example .env\n"
            f"  2. Add your key to .env\n"
            f"  Get one at: {help_url}"
        )
    return value
