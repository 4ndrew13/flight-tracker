#!/usr/bin/env python3
"""Entry point so you can run `python3 ft.py <command>` from the repo root."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from flighttracker.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
