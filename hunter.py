#!/usr/bin/env python3
"""crow-hunter — Bounty Hunter v1: finds work an agent may execute end-to-end.

Lanes:
1. github_pr — GitHub-native bounties ('bounty' labels, Algora-style). The
   deliverable is a pull request, which an automated worker may open.
2. listing  — opportunities explicitly flagged AGENT_ALLOWED by their source.

Writes executable_queue.json, consumed by worker.py. Stdlib only; the
unauthenticated GitHub search quota is plenty for one daily run.
"""

import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

AMOUNT = re.compile(r"\$\s?([\d,]+)")
SMALL_HINTS = ("docs", "documentation", "typo", "readme", "good first issue",
               "help wanted", "chore", "config")


def gh_search(q, per_page=30):
    url = "https://api.github.com/search/issues?" + urllib.parse.urlencode(
        {"q": q, "sort": "created", "order": "desc", "per_page": per_page})
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "crow-hunter"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("items", [])


def amount_of(issue):
    for field in (issue.get("title") or "", issue.get("body") or ""):
        m = AMOUNT.search(field)
        if m:
            try:
                return int(m.group(1).replace(",", ""))
            except ValueError:
                pass
    return None


def main():
    queue, seen = [], set()
    for q in ('label:"💎 Bounty" state:open is:issue',
              'label:bounty state:open is:issue "$"'):
        try:
            for it in gh_search(q):
                if it["html_url"] in seen:
                    continue
                seen.add(it["html_url"])
                amt = amount_of(it)
                if not amt or amt < 20:
                    continue
                labels = [l["name"].lower() for l in it.get("labels", [])]
                text = (it["title"] + " " + " ".join(labels)).lower()
                queue.append({
                    "lane": "github_pr",
                    "title": it["title"],
                    "url": it["html_url"],
                    "repo": "/".join(it["repository_url"].split("/")[-2:]),
                    "issue_number": it.get("number"),
                    "value_usd": amt,
                    "labels": labels,
                    "small": any(h in text for h in SMALL_HINTS),
                    "created": it.get("created_at"),
                })
        except Exception as e:  # rate limit or network — degrade gracefully
            print("search failed:", e)

    try:
        for o in json.loads(Path("opportunities.json").read_text()):
            if o.get("agent_access") == "AGENT_ALLOWED":
                queue.append({"lane": "listing", "title": o["title"],
                              "url": o["url"], "value_usd": o.get("value_usd"),
                              "token": o.get("token"),
                              "days_left": o.get("days_left"), "small": True})
    except Exception as e:
        print("no opportunities.json:", e)

    # Small, agent-tractable work first; then by value.
    queue.sort(key=lambda x: (not x.get("small"), -(x.get("value_usd") or 0)))
    out = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "count": len(queue), "items": queue[:40]}
    Path("executable_queue.json").write_text(json.dumps(out, indent=1))
    print(f"{len(queue)} executable bounties -> executable_queue.json")


if __name__ == "__main__":
    main()
