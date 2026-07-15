#!/usr/bin/env python3
"""crow-stats — Analytics v0: appends a daily pipeline snapshot to stats.csv.

Idempotent per day (re-runs overwrite today's row). Stdlib only.
"""

import csv
import json
from datetime import datetime, timezone
from pathlib import Path

HEADER = ["date", "open", "face_usd", "agent_allowed", "new", "closing_3d"]


def main():
    opps = json.loads(Path("opportunities.json").read_text())
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    row = [
        today,
        len(opps),
        round(sum(o.get("value_usd") or 0 for o in opps)),
        sum(1 for o in opps if o.get("agent_access") == "AGENT_ALLOWED"),
        sum(1 for o in opps if o.get("is_new")),
        sum(1 for o in opps if o.get("days_left") is not None and o["days_left"] <= 3),
    ]

    p = Path("stats.csv")
    rows = [HEADER]
    if p.exists():
        with p.open() as f:
            existing = [r for r in csv.reader(f) if r]
        rows = [existing[0]] + [r for r in existing[1:] if r[0] != today]
    rows.append([str(x) for x in row])

    with p.open("w", newline="") as f:
        csv.writer(f).writerows(rows)
    print(f"stats snapshot {today}: {row[1]} open, ${row[2]:,} face value")


if __name__ == "__main__":
    main()
