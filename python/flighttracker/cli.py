"""Command-line entry point: collect, report, backfill, history, doctor."""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import date

from . import db, report, signal, stats
from .config import ConfigError, load_config, load_env
from .providers import amadeus, serpapi
from .providers.serpapi import ProviderError


def _indent(text: str, pad: str = "    ") -> str:
    return text.replace("\n", "\n" + pad)


def _fail(message: str) -> int:
    print(f"\n  error: {_indent(str(message), '  ')}\n", file=sys.stderr)
    return 1


def cmd_collect(args) -> int:
    cfg = load_config()
    db.init_db()
    trips = cfg.enabled_trips
    if args.trip:
        trips = [t for t in trips if t.id == args.trip]
    if not trips:
        return _fail("No enabled trips in config.json (or --trip matched nothing).")

    failures = 0
    with db.connect() as conn:
        for trip in trips:
            print(f"  fetching {trip.route_id} ...", end=" ", flush=True)
            try:
                snap = serpapi.fetch(trip, cfg, save_raw=not args.no_raw)
            except (ProviderError, ConfigError) as exc:
                print("failed")
                print(f"    {exc}", file=sys.stderr)
                failures += 1
                continue

            snapshot_id = db.insert_snapshot(conn, snap)

            # Seed history from Google's own price_history the first time we see
            # a route — it gives us weeks of trend data on day one.
            points = serpapi.history_points(snap)
            for point_date, price in points:
                db.upsert_history_point(conn, trip.route_id, point_date, price, "google_history")

            level = snap.get("price_level") or "?"
            print(f"${snap.get('lowest_price')} ({level}), "
                  f"{snap.get('n_offers')} offers, +{len(points)} history points")

    if failures:
        return _fail(f"{failures} of {len(trips)} trip(s) failed.")
    print("\n  done. run `python3 ft.py report` to see the verdict.\n")
    return 0


def _analyze(conn, trip, cfg, use_amadeus: bool = True):
    series = db.daily_series(conn, trip.route_id)
    avg_series = db.daily_avg_series(conn, trip.route_id)
    snap = db.latest_snapshot(conn, trip.route_id)
    if snap is None:
        return None

    summary = stats.summarize(series)
    avg_summary = stats.summarize(avg_series)

    metrics = None
    if use_amadeus and amadeus.is_configured():
        metrics = amadeus.price_metrics(
            trip.origin, trip.destination, trip.outbound_date, cfg.currency
        )

    verdict = signal.evaluate(
        current_price=snap["lowest_price"],
        summary=summary,
        price_level=snap["price_level"],
        typical_low=snap["typical_low"],
        typical_high=snap["typical_high"],
        departure_date=trip.outbound_date,
        weights=cfg.weights,
        thresholds=cfg.thresholds,
        amadeus_metrics=metrics,
    )
    offers = [dict(o) for o in db.cheapest_offers(conn, snap["id"], limit=5)]
    return series, avg_series, summary, avg_summary, verdict, snap, offers


def cmd_report(args) -> int:
    cfg = load_config()
    db.init_db()
    trips = cfg.enabled_trips
    if args.trip:
        trips = [t for t in trips if t.id == args.trip]

    shown = 0
    with db.connect() as conn:
        for trip in trips:
            result = _analyze(conn, trip, cfg, use_amadeus=not args.no_amadeus)
            if result is None:
                print(f"\n  no data yet for {trip.route_id} — run `python3 ft.py collect` first\n")
                continue
            series, _avg_series, summary, avg_summary, verdict, snap, offers = result
            print(report.render(
                trip_label=trip.label,
                route=f"{trip.origin} → {trip.destination}  "
                      f"{trip.outbound_date}"
                      + (f" – {trip.return_date}" if trip.return_date else ""),
                currency=snap["currency"],
                summary=summary,
                avg_summary=avg_summary,
                verdict=verdict,
                price_level=snap["price_level"],
                typical_low=snap["typical_low"],
                typical_high=snap["typical_high"],
                series=series,
                offers=offers,
            ))
            shown += 1

    if not shown:
        return _fail("Nothing to report. Run `python3 ft.py collect` first.")
    return 0


def cmd_history(args) -> int:
    """Dump the daily series as CSV for spreadsheets or plotting."""
    cfg = load_config()
    db.init_db()
    writer = csv.writer(sys.stdout)
    writer.writerow(["route_id", "date", "cheapest_price"])
    with db.connect() as conn:
        for trip in cfg.enabled_trips:
            if args.trip and trip.id != args.trip:
                continue
            for day, price in db.daily_series(conn, trip.route_id):
                writer.writerow([trip.route_id, day, price])
    return 0


def cmd_doctor(args) -> int:
    """Check that config and credentials are usable before the first real run."""
    import os

    print("\n  Configuration check")
    print("  " + "─" * 50)

    ok = True
    key = os.environ.get("SERPAPI_KEY", "").strip()
    if key:
        print(f"  SERPAPI_KEY          set ({key[:6]}…{key[-4:]})")
    else:
        print("  SERPAPI_KEY          MISSING — required. See .env.example")
        ok = False

    if amadeus.is_configured():
        print("  Amadeus              set (optional cross-check enabled)")
    else:
        print("  Amadeus              not set (optional — tracker works without it)")

    try:
        cfg = load_config()
    except ConfigError as exc:
        print(f"\n  config.json          PROBLEM\n    {_indent(str(exc))}\n")
        return 1

    print(f"  config.json          ok — {len(cfg.enabled_trips)} enabled trip(s)")
    for trip in cfg.enabled_trips:
        days = (date.fromisoformat(trip.outbound_date) - date.today()).days
        flag = "" if 0 < days <= 330 else "  <-- outside the usual 11-month booking window"
        print(f"    • {trip.id:<12} {trip.origin}→{trip.destination} "
              f"{trip.outbound_date} ({days} days out){flag}")

    print(f"  passengers           {cfg.passengers}")
    print(f"  currency             {cfg.currency}\n")

    if ok:
        print("  Ready. Run: python3 ft.py collect\n")
        return 0
    print("  Fix the items above, then run: python3 ft.py doctor\n")
    return 1


def main(argv: list[str] | None = None) -> int:
    load_env()
    parser = argparse.ArgumentParser(
        prog="ft", description="Track flight prices and get a buy/wait verdict."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("collect", help="poll the API and store today's prices")
    p.add_argument("--trip", help="only this trip id")
    p.add_argument("--no-raw", action="store_true", help="don't save raw API payloads")
    p.set_defaults(func=cmd_collect)

    p = sub.add_parser("report", help="show the analysis and buy indicator")
    p.add_argument("--trip", help="only this trip id")
    p.add_argument("--no-amadeus", action="store_true", help="skip the Amadeus cross-check")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("history", help="dump the daily price series as CSV")
    p.add_argument("--trip", help="only this trip id")
    p.set_defaults(func=cmd_history)

    p = sub.add_parser("doctor", help="verify keys and config before the first run")
    p.set_defaults(func=cmd_doctor)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        return _fail(str(exc))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
