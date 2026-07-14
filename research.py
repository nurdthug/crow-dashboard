#!/usr/bin/env python3
"""crow-research — zero-cost triage layer for today's scout results.

Reads opportunities.json and writes research.md with the few items most worth
human attention. No APIs, no model calls, no accounts.
"""

import json
from datetime import datetime, timezone
from pathlib import Path


def effort(o):
    title = (o.get("title") or "").lower()
    typ = (o.get("type") or "").lower()
    if "video" in title or "content" in title or "twitter" in title:
        return "low-medium"
    if "hackathon" in typ or "build" in title or "developer" in title:
        return "high"
    if "deep dive" in title or "infographic" in title:
        return "medium"
    return "medium"


def fit_score(o):
    score = float(o.get("score") or 0)
    days = o.get("days_left")
    comp = o.get("competition")
    title = (o.get("title") or "").lower()
    typ = (o.get("type") or "").lower()

    fit = score
    if days is not None and days < 1:
        fit *= 0.25
    elif days is not None and days < 3:
        fit *= 0.7
    if comp is not None and comp > 1000:
        fit *= 0.35
    elif comp is not None and comp > 100:
        fit *= 0.65
    if o.get("agent_access") == "AGENT_ALLOWED":
        fit *= 2.0
    if any(w in title for w in ["video", "twitter", "content", "infographic"]):
        fit *= 1.2
    if "hackathon" in typ and (comp or 0) > 2000:
        fit *= 0.5
    return round(fit, 2)


def rationale(o):
    bits = []
    if o.get("agent_access") == "AGENT_ALLOWED":
        bits.append("explicitly agent-allowed")
    if o.get("sponsor_verified"):
        bits.append("verified sponsor")
    if o.get("competition") == 0:
        bits.append("no visible competition yet")
    elif o.get("competition") is not None and o["competition"] < 10:
        bits.append("low competition")
    if o.get("days_left") is not None and o["days_left"] < 3:
        bits.append("urgent")
    if not bits:
        bits.append("reasonable EV after competition/deadline adjustment")
    return ", ".join(bits)


def next_step(o):
    title = (o.get("title") or "").lower()
    if "twitter" in title:
        return "Draft thread outline and verify rules before posting."
    if "video" in title or "content" in title:
        return "Draft script/angle and collect required brand/rule links."
    if "hackathon" in (o.get("type") or "").lower():
        return "Read rules, judging criteria, and required deliverables; decide if a tiny MVP is possible."
    if "deep dive" in title:
        return "Create research outline and source list; estimate writing time."
    return "Open listing, capture rules/deadline/payout terms, and decide go/no-go."


def recommendation(i, o):
    days_left = o.get("days_left")
    return {
        "rank": i,
        "fit": fit_score(o),
        "title": o["title"],
        "url": o["url"],
        "value_usd": o["value_usd"],
        "token": o.get("token", "USD"),
        "why": rationale(o),
        "next_step": next_step(o),
        "effort": effort(o),
        "days_left": round(days_left, 1) if days_left is not None else None,
        "competition": o.get("competition"),
        "deadline": o.get("deadline"),
        "source": o.get("source"),
        "agent_access": o.get("agent_access"),
    }


def is_trap(o):
    return (o.get("competition") or 0) > 1000


def main():
    opps = json.loads(Path("opportunities.json").read_text())
    ranked = sorted(opps, key=fit_score, reverse=True)
    traps = [o for o in ranked if is_trap(o)][:5]
    chaseable = [o for o in ranked if not is_trap(o)]
    top = (chaseable or ranked)[:10]
    agent = [o for o in ranked if o.get("agent_access") == "AGENT_ALLOWED"]
    generated_at = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    lines = [
        f"# Crow Research Brief — {generated_at}",
        "",
        "This is the first triage pass after Scout. It favors realistic wins over giant headline prizes.",
        "",
        f"**Reviewed:** {len(opps)} opportunities · **Agent-allowed:** {len(agent)} · **Recommended focus:** top 3 below",
        "",
        "| # | Fit | Effort | Opportunity | Value | Why | Next step |",
        "|---|---:|---|---|---:|---|---|",
    ]
    for i, o in enumerate(top, 1):
        lines.append(
            f"| {i} | {fit_score(o):,.0f} | {effort(o)} | [{o['title']}]({o['url']}) "
            f"| ${o['value_usd']:,.0f} {o.get('token','USD')} | {rationale(o)} | {next_step(o)} |"
        )

    lines += [
        "",
        "## Do Not Chase First",
        "",
    ]
    for o in traps:
        lines.append(f"- [{o['title']}]({o['url']}): huge pool, but competition is already {o.get('competition'):,}.")

    Path("research.md").write_text("\n".join(lines))
    Path("research.json").write_text(json.dumps({
        "generated_at": generated_at,
        "reviewed": len(opps),
        "agent_allowed": len(agent),
        "recommendations": [recommendation(i, o) for i, o in enumerate(top, 1)],
        "avoid_first": [{
            "title": o["title"],
            "url": o["url"],
            "competition": o.get("competition"),
            "reason": "huge pool, but high visible competition",
        } for o in traps],
    }, indent=2))
    print(f"{len(top)} recommendations -> research.md + research.json")


if __name__ == "__main__":
    main()
