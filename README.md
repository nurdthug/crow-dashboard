# Crow Network

[![ci](https://github.com/nurdthug/crow-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/nurdthug/crow-dashboard/actions/workflows/ci.yml)
[![daily scout](https://github.com/nurdthug/crow-dashboard/actions/workflows/scout.yml/badge.svg)](https://github.com/nurdthug/crow-dashboard/actions/workflows/scout.yml)

Zero-spend public dashboard and stable machine discovery origin for autonomous
Crow services.

Live site: https://nurdthug.github.io/crow-dashboard/

Crow Oracle sells machine-readable Solana answers through x402 exact payment:

- `token-risk-check`: Solana token risk verdict, currently advertised at `0.03 USDC`.
- `lending-health`: Kamino lending-health signal, currently advertised at `0.05 USDC`.

Start here if you are a buyer or integrator: [Crow Oracle buyer quickstart](BUYERS.md).

## What runs

- `oracle.json` is the stable Crow Oracle discovery beacon.
- `.well-known/crow-oracle.json` mirrors the beacon for machine clients.
- `scripts/update-oracle-beacon.mjs` verifies the live health, catalog, free
  sample, both unpaid quotes, and their bound v1/v2 contracts before changing
  the advertised temporary backend.
- `scripts/sync-oracle-beacon.sh` publishes only when the verified backend or
  payment contract changes.
- `scout.py` scans live public opportunity sources and writes `opportunities.json` plus `digest.md`.
- `research.py` ranks the current opportunities into `research.json` and `research.md`.
- GitHub Actions runs the scout daily at 13:17 UTC and can also be started manually with `workflow_dispatch`.
- GitHub Pages serves `index.html` as the live dashboard.

## Current artifacts

- [Dashboard](https://nurdthug.github.io/crow-dashboard/)
- [Crow Oracle discovery](https://nurdthug.github.io/crow-dashboard/oracle.json)
- [Crow Oracle well-known discovery](https://nurdthug.github.io/crow-dashboard/.well-known/crow-oracle.json)
- [Buyer quickstart](BUYERS.md)
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
- Crow Oracle output is a machine-readable risk signal, not investment advice,
  custody, or a guarantee of trading or lending outcomes.
- Oracle backend updates reject redirects, credential-bearing URLs, unexpected
  hostnames, service/version/protocol mismatches, malformed v2 headers, and
  payment-address, amount, asset, network, or facilitator rebinding.
- The beacon labels the backend as temporary and tells buyers to recheck live
  health and the unpaid quote before signing or transmitting payment.
- Only unique confirmed x402 settlement signatures count as Crow revenue.
- Alerts use configured GitHub secrets when present and skip safely when missing.

## Trust files

- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)
- [MIT license](LICENSE)

## Agent flow

1. Fetch the stable `oracle.json` beacon.
2. Recheck the advertised backend health and current unpaid 402 quote.
3. Evaluate the free sample and machine contract.
4. Use the advertised x402 v2 exact contract or the preserved legacy v1 path.
5. Verify the paid response with the offline receipt verifier.

## Buyer flow

1. Fetch the stable beacon.
2. Choose `token-risk-check` or `lending-health` from the current `products`.
3. Try the free sample for response shape.
4. Request the paid resource without payment to receive the current HTTP 402 quote.
5. Pay only the exact resource, amount, asset, and merchant fields advertised by
   the live quote.
6. Verify the paid response with the advertised offline receipt verifier.
