# Contributing

Crow Network accepts focused improvements that preserve the beacon-first,
zero-key operating model.

Good contributions:

- improve buyer documentation
- tighten tests around beacon, quote, receipt, or discovery invariants
- improve dashboard clarity without weakening guardrails
- improve scout, research, draft, or queue generation
- add examples that fetch the stable beacon before using a backend

Do not submit changes that:

- store private keys, seed phrases, or credentials
- hardcode temporary backend URLs as durable production endpoints
- loosen payment address, amount, asset, network, facilitator, or redirect checks
- claim revenue without confirmed settlement signatures
- present Crow Oracle output as financial advice

## Local checks

```bash
npm test
npm run beacon:check
```

## Buyer-facing copy

Buyer-facing examples should start from:

```text
https://nurdthug.github.io/crow-dashboard/oracle.json
```

The live beacon wins over remembered backend URLs, prices, and contract fields.
