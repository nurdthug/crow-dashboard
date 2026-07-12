#!/usr/bin/env python3
"""
crow-scout — The Crow Network's Opportunity Scout (working MVP).

Scans live opportunity sources, normalizes + scores them, and writes:
  - digest.md            human-readable ranked digest
  - opportunities.json   machine-readable index (for other agents)
  - .scout_seen.json     state file so re-runs flag what's NEW

Zero dependencies (Python 3.9+ stdlib only).

Usage:
  python3 scout.py                 # live scan
  python3 scout.py --min-usd 500   # filter small stuff
  python3 scout.py --from-fixtures fixtures/  # offline mode (tests/demo)
  python3 scout.py --selftest      # run built-in tests
"""

import argparse
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UA = {"User-Agent": "crow-scout/0.1 (+github.com/nurdthug/crow-network; polite bot)"}
NOW = datetime.now(timezone.utc)


# ---------------------------------------------------------------- fetch

def get_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------- model

def opportunity(**kw):
    """Normalized opportunity record."""
    o = {
        "source": None, "type": None, "title": None, "url": None,
        "sponsor": None, "sponsor_verified": False,
        "value_usd": 0.0, "token": "USD", "deadline": None,
        "days_left": None, "competition": None,       # submissions/registrations
        "agent_access": "HUMAN_ONLY",                  # HUMAN_ONLY | AGENT_ALLOWED
        "themes": [], "score": 0.0,
    }
    o.update(kw)
    return o


def days_until(iso: str):
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return max(0.0, (dt - NOW).total_seconds() / 86400.0)
    except Exception:
        return None


# ---------------------------------------------------------------- adapters

def adapt_superteam(data):
    """Superteam Earn: crypto bounties/projects, USDC/USDG, has agentAccess flag."""
    out = []
    for it in data:
        if it.get("status") != "OPEN":
            continue
        dl = it.get("deadline")
        out.append(opportunity(
            source="superteam-earn",
            type=it.get("type", "bounty"),
            title=it.get("title"),
            url=f"https://earn.superteam.fun/listings/{it.get('slug')}",
            sponsor=(it.get("sponsor") or {}).get("name"),
            sponsor_verified=bool((it.get("sponsor") or {}).get("isVerified")),
            value_usd=float(it.get("rewardAmount") or 0),  # USDC/USDG ~ USD
            token=it.get("token") or "USDC",
            deadline=dl,
            days_left=days_until(dl) if dl else None,
            competition=(it.get("_count") or {}).get("Submission"),
            agent_access=it.get("agentAccess") or "HUMAN_ONLY",
        ))
    return out


_MONEY = re.compile(r"[\d,]+")

def adapt_devpost(data):
    """Devpost: global online hackathons (fiat + crypto sponsors)."""
    out = []
    for h in data.get("hackathons", []):
        if h.get("open_state") != "open":
            continue
        raw = re.sub(r"<[^>]+>", "", h.get("prize_amount") or "")
        m = _MONEY.search(raw)
        value = float(m.group().replace(",", "")) if m else 0.0
        out.append(opportunity(
            source="devpost",
            type="hackathon",
            title=h.get("title"),
            url=h.get("url"),
            sponsor=h.get("organization_name"),
            sponsor_verified=bool(h.get("managed_by_devpost_badge")),
            value_usd=value,
            deadline=None,  # devpost exposes human string, not ISO
            days_left=_devpost_days(h.get("time_left_to_submission") or ""),
            competition=h.get("registrations_count"),
            agent_access="HUMAN_ONLY",
            themes=[t.get("name") for t in h.get("themes", [])],
        ))
    return out


def _devpost_days(s: str):
    m = re.search(r"(\d+)\s+day", s)
    if m:
        return float(m.group(1))
    m = re.search(r"(\d+)\s+month", s)
    if m:
        return float(m.group(1)) * 30.0
    return None


SOURCES = {
    "superteam-earn": {
        "url": "https://earn.superteam.fun/api/listings?take=100",
        "adapt": adapt_superteam,
    },
    "devpost": {
        "url": "https://devpost.com/api/hackathons?challenge_type[]=online&status[]=open",
        "adapt": adapt_devpost,
    },
    # Add adapters here: DoraHacks, Immunefi, Questbook, Gitcoin, DePIN programs…
}


# ---------------------------------------------------------------- scoring

def score(o):
    """EV-style priority score. Transparent heuristic, tune freely.

    score = value * p_win_proxy * urgency_fit * trust
    """
    value = o["value_usd"] or 0.0

    # competition: more submissions => lower win probability proxy
    comp = o["competition"]
    if comp is None:
        p_win = 0.10
    else:
        p_win = max(0.02, 1.0 / (1.0 + comp / 8.0))

    # deadline fit: too soon (<2d) is risky, weeks out is fine
    d = o["days_left"]
    if d is None:
        urgency = 0.8
    elif d < 1:
        urgency = 0.2
    elif d < 3:
        urgency = 0.6
    else:
        urgency = 1.0

    trust = 1.0 if o["sponsor_verified"] else 0.75
    agent_boost = 1.5 if o["agent_access"] == "AGENT_ALLOWED" else 1.0

    return round(value * p_win * urgency * trust * agent_boost, 2)


# ---------------------------------------------------------------- pipeline

def dedupe(opps):
    seen, out = set(), []
    for o in opps:
        k = o["url"]
        if k and k not in seen:
            seen.add(k)
            out.append(o)
    return out


def run(min_usd=0.0, fixtures=None, outdir="."):
    opps = []
    errors = []
    for name, src in SOURCES.items():
        try:
            if fixtures:
                p = Path(fixtures) / f"{name}.json"
                data = json.loads(p.read_text())
            else:
                data = get_json(src["url"])
            opps.extend(src["adapt"](data))
        except Exception as e:  # a dead source never kills the sweep
            errors.append(f"{name}: {e}")

    opps = [o for o in dedupe(opps) if o["value_usd"] >= min_usd]
    for o in opps:
        o["score"] = score(o)
    opps.sort(key=lambda o: o["score"], reverse=True)

    # new-since-last-run
    state_path = Path(outdir) / ".scout_seen.json"
    seen_before = set(json.loads(state_path.read_text())) if state_path.exists() else set()
    for o in opps:
        o["is_new"] = o["url"] not in seen_before
    state_path.write_text(json.dumps(sorted({o["url"] for o in opps} | seen_before)))

    Path(outdir, "opportunities.json").write_text(json.dumps(opps, indent=2))
    Path(outdir, "digest.md").write_text(render_digest(opps, errors))
    return opps, errors


def render_digest(opps, errors):
    new = [o for o in opps if o.get("is_new")]
    agent_ok = [o for o in opps if o["agent_access"] == "AGENT_ALLOWED"]
    lines = [
        f"# Crow Scout Digest — {NOW.strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        f"**{len(opps)} open opportunities** · {len(new)} new since last run · "
        f"{len(agent_ok)} flagged AGENT_ALLOWED · total face value "
        f"${sum(o['value_usd'] for o in opps):,.0f}",
        "",
        "| # | Score | Title | Value | Type | Source | Days left | Competition | Agent? |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for i, o in enumerate(opps[:25], 1):
        dl = f"{o['days_left']:.0f}" if o["days_left"] is not None else "—"
        comp = str(o["competition"]) if o["competition"] is not None else "—"
        flag = "🤖" if o["agent_access"] == "AGENT_ALLOWED" else ""
        star = " 🆕" if o.get("is_new") else ""
        lines.append(
            f"| {i} | {o['score']:,.0f} | [{o['title']}]({o['url']}){star} "
            f"| ${o['value_usd']:,.0f} {o['token']} | {o['type']} | {o['source']} "
            f"| {dl} | {comp} | {flag} |"
        )
    if errors:
        lines += ["", "## Source errors", ""] + [f"- {e}" for e in errors]
    lines += ["", "*Scores are EV heuristics (value × win-probability proxy × "
              "urgency × sponsor trust). Verify terms before committing work.*"]
    return "\n".join(lines)


# ---------------------------------------------------------------- selftest

def selftest():
    st = adapt_superteam([{
        "status": "OPEN", "type": "bounty", "title": "T", "slug": "t",
        "rewardAmount": 500, "token": "USDC", "deadline": "2099-01-01T00:00:00.000Z",
        "agentAccess": "AGENT_ALLOWED", "_count": {"Submission": 8},
        "sponsor": {"name": "S", "isVerified": True},
    }])
    assert len(st) == 1 and st[0]["value_usd"] == 500
    assert st[0]["agent_access"] == "AGENT_ALLOWED"

    dp = adapt_devpost({"hackathons": [{
        "open_state": "open", "title": "H", "url": "https://x.devpost.com",
        "prize_amount": "$<span>80,000</span>", "registrations_count": 4000,
        "time_left_to_submission": "17 days left",
        "organization_name": "Org", "managed_by_devpost_badge": True, "themes": [],
    }]})
    assert dp[0]["value_usd"] == 80000.0 and dp[0]["days_left"] == 17.0

    s1, s2 = score(st[0]), score(dict(st[0], agent_access="HUMAN_ONLY"))
    assert s1 > s2, "agent-allowed must outrank equal human-only"
    assert dedupe([st[0], dict(st[0])]) == [st[0]]
    print("selftest OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-usd", type=float, default=0.0)
    ap.add_argument("--from-fixtures", default=None)
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        sys.exit(0)
    opps, errs = run(min_usd=a.min_usd, fixtures=a.from_fixtures, outdir=a.outdir)
    print(f"{len(opps)} opportunities → digest.md, opportunities.json"
          + (f" ({len(errs)} source errors)" if errs else ""))
