"""SQLite storage for price snapshots.

Three tables:
  snapshots      - one row per API poll (the headline numbers for that moment)
  offers         - individual itineraries within a snapshot, for airline-level detail
  history_points - daily price points, including ones backfilled from Google's
                   own price_history so the tracker isn't blind on day one
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id      TEXT NOT NULL,
    trip_id       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    captured_at   TEXT NOT NULL,
    capture_date  TEXT NOT NULL,
    origin        TEXT NOT NULL,
    destination   TEXT NOT NULL,
    outbound_date TEXT NOT NULL,
    return_date   TEXT,
    currency      TEXT NOT NULL,
    lowest_price  INTEGER,
    avg_price     REAL,
    median_price  REAL,
    n_offers      INTEGER,
    price_level   TEXT,
    typical_low   INTEGER,
    typical_high  INTEGER,
    raw_path      TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_route_date
    ON snapshots(route_id, capture_date);

CREATE TABLE IF NOT EXISTS offers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id    INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    price          INTEGER,
    airline        TEXT,
    flight_numbers TEXT,
    stops          INTEGER,
    total_duration INTEGER,
    departure_time TEXT,
    arrival_time   TEXT,
    layovers       TEXT,
    is_best        INTEGER DEFAULT 0,
    booking_token  TEXT
);

CREATE INDEX IF NOT EXISTS idx_offers_snapshot ON offers(snapshot_id);

CREATE TABLE IF NOT EXISTS history_points (
    route_id TEXT NOT NULL,
    date     TEXT NOT NULL,
    price    INTEGER NOT NULL,
    source   TEXT NOT NULL,
    PRIMARY KEY (route_id, date, source)
);
"""


@contextmanager
def connect(path: Path | None = None):
    # Resolved at call time so the path stays overridable.
    path = path or DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(path: Path | None = None) -> None:
    with connect(path or DB_PATH) as conn:
        conn.executescript(SCHEMA)


def insert_snapshot(conn: sqlite3.Connection, snap: dict) -> int:
    """Store one poll result. Returns the new snapshot id."""
    now = datetime.now(timezone.utc)
    cur = conn.execute(
        """
        INSERT INTO snapshots (
            route_id, trip_id, provider, captured_at, capture_date,
            origin, destination, outbound_date, return_date, currency,
            lowest_price, avg_price, median_price, n_offers,
            price_level, typical_low, typical_high, raw_path
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            snap["route_id"],
            snap["trip_id"],
            snap["provider"],
            now.isoformat(),
            now.date().isoformat(),
            snap["origin"],
            snap["destination"],
            snap["outbound_date"],
            snap.get("return_date"),
            snap["currency"],
            snap.get("lowest_price"),
            snap.get("avg_price"),
            snap.get("median_price"),
            snap.get("n_offers"),
            snap.get("price_level"),
            snap.get("typical_low"),
            snap.get("typical_high"),
            snap.get("raw_path"),
        ),
    )
    snapshot_id = cur.lastrowid

    for offer in snap.get("offers", []):
        conn.execute(
            """
            INSERT INTO offers (
                snapshot_id, price, airline, flight_numbers, stops,
                total_duration, departure_time, arrival_time, layovers,
                is_best, booking_token
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                snapshot_id,
                offer.get("price"),
                offer.get("airline"),
                offer.get("flight_numbers"),
                offer.get("stops"),
                offer.get("total_duration"),
                offer.get("departure_time"),
                offer.get("arrival_time"),
                json.dumps(offer.get("layovers", [])),
                1 if offer.get("is_best") else 0,
                offer.get("booking_token"),
            ),
        )

    # A snapshot's own lowest price is also a history point for today.
    if snap.get("lowest_price"):
        upsert_history_point(
            conn, snap["route_id"], now.date().isoformat(),
            snap["lowest_price"], source="observed",
        )
    return snapshot_id


def upsert_history_point(
    conn: sqlite3.Connection, route_id: str, date: str, price: int, source: str
) -> None:
    """Insert a daily price point, keeping the lowest price seen that day."""
    conn.execute(
        """
        INSERT INTO history_points (route_id, date, price, source)
        VALUES (?,?,?,?)
        ON CONFLICT(route_id, date, source)
        DO UPDATE SET price = MIN(price, excluded.price)
        """,
        (route_id, date, price, source),
    )


def daily_series(
    conn: sqlite3.Connection, route_id: str, prefer_source: str = "observed"
) -> list[tuple[str, int]]:
    """Daily (date, price) series for a route, oldest first.

    Uses our own observations where we have them and falls back to Google's
    backfilled history for days we weren't running yet.
    """
    rows = conn.execute(
        """
        SELECT date,
               MIN(CASE WHEN source = ? THEN price END) AS preferred,
               MIN(price) AS any_price
        FROM history_points
        WHERE route_id = ?
        GROUP BY date
        ORDER BY date ASC
        """,
        (prefer_source, route_id),
    ).fetchall()
    return [(r["date"], r["preferred"] if r["preferred"] is not None else r["any_price"])
            for r in rows]


def daily_avg_series(conn: sqlite3.Connection, route_id: str) -> list[tuple[str, float]]:
    """Daily mean-of-all-offers series — the 'average price on the day'."""
    rows = conn.execute(
        """
        SELECT capture_date AS date, AVG(avg_price) AS avg_price
        FROM snapshots
        WHERE route_id = ? AND avg_price IS NOT NULL
        GROUP BY capture_date
        ORDER BY capture_date ASC
        """,
        (route_id,),
    ).fetchall()
    return [(r["date"], r["avg_price"]) for r in rows]


def latest_snapshot(conn: sqlite3.Connection, route_id: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM snapshots
        WHERE route_id = ?
        ORDER BY captured_at DESC
        LIMIT 1
        """,
        (route_id,),
    ).fetchone()


def cheapest_offers(
    conn: sqlite3.Connection, snapshot_id: int, limit: int = 5
) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM offers
        WHERE snapshot_id = ? AND price IS NOT NULL
        ORDER BY price ASC
        LIMIT ?
        """,
        (snapshot_id, limit),
    ).fetchall()


def tracked_routes(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("SELECT DISTINCT route_id FROM snapshots").fetchall()
    return [r["route_id"] for r in rows]
