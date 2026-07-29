# Crow Network

Zero-spend public dashboard and stable machine discovery origin for autonomous
Crow services.

Live site: https://nurdthug.github.io/crow-dashboard/

## What runs

- `oracle.json` is the stable Crow Oracle discovery beacon.
- `.well-known/crow-oracle.json` mirrors the beacon for machine clients.
- `scripts/update-oracle-beacon.mjs` verifies the live health, catalog, free
  sample, and unpaid quote before changing the advertised temporary backend.
- `scripts/sync-oracle-beacon.sh` publishes a change only when the verified
  backend URL changes.
- `scout.py` scans live public opportunity sources and writes `opportunities.json` plus `digest.md`.
- `research.py` ranks the current opportunities into `research.json` and `research.md`.
- GitHub Actions runs the scout daily at 13:17 UTC and can also be started manually with `workflow_dispatch`.
- GitHub Pages serves `index.html` as the live dashboard.

## Current artifacts

- [Dashboard](https://nurdthug.github.io/crow-dashboard/)
- [Crow Oracle discovery](https://nurdthug.github.io/crow-dashboard/oracle.json)
- [Crow Oracle well-known discovery](https://nurdthug.github.io/crow-dashboard/.well-known/crow-oracle.json)
- [Agent context](https://nurdthug.github.io/crow-dashboard/llms.txt)
- [Research brief](research.md)
- [Research data](research.json)
- [Scout digest](digest.md)
- [Opportunity data](opportunities.json)
- [Daily scout workflow](https://github.com/nurdthug/crow-dashboard/actions/workflows/scout.yml)

## Guardrails

- No paid APIs are used.
- No wallet keys or private credentials are stored here.
- Treasury display is watch-only public addresses.
- Oracle backend updates reject redirects, credential-bearing URLs, unexpected
  hostnames, service/version/protocol mismatches, and payment-address rebinding.
- The beacon labels the backend as temporary and tells buyers to recheck live
  health and the unpaid quote before signing or transmitting payment.
- Only unique confirmed x402 settlement signatures count as Crow revenue.
- Alerts use configured GitHub secrets when present and skip safely when missing.

## Agent flow

1. Fetch the stable `oracle.json` beacon.
2. Recheck the advertised backend health and current unpaid 402 quote.
3. Evaluate the free sample and machine contract.
4. Use the zero-key buyer client with an already-signed exact transfer.
5. Verify the paid response with the offline receipt verifier.
