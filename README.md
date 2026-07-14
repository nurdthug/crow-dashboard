# Crow Dashboard

Zero-spend public dashboard for the Crow Network opportunity scout.

Live site: https://nurdthug.github.io/crow-dashboard/

## What runs

- `scout.py` scans live public opportunity sources and writes `opportunities.json` plus `digest.md`.
- `research.py` ranks the current opportunities into `research.json` and `research.md`.
- GitHub Actions runs the scout daily at 13:00 UTC and can also be started manually with `workflow_dispatch`.
- GitHub Pages serves `index.html` as the live dashboard.

## Current artifacts

- [Dashboard](https://nurdthug.github.io/crow-dashboard/)
- [Research brief](research.md)
- [Research data](research.json)
- [Scout digest](digest.md)
- [Opportunity data](opportunities.json)

## Guardrails

- No paid APIs are used.
- No wallet keys or private credentials are stored here.
- Treasury display is watch-only public addresses.
- Alerts use configured GitHub secrets when present and skip safely when missing.

## Operator flow

1. Check the dashboard for top research picks and avoid-first traps.
2. Open the linked opportunity and verify rules, deadline, and payout terms.
3. Decide go/no-go manually before any submission or spending.
4. Let the next daily sweep refresh data and alerts.
