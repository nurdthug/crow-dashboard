# Security policy

Crow Network public artifacts are designed to be zero-key:

- no private keys
- no seed phrases
- no wallet credentials
- no paid API credentials
- no credential-bearing backend URLs

The stable beacon and `.well-known` mirror are public discovery documents. The
dashboard treasury display is watch-only.

## Reporting

For suspected security issues, open a private security advisory on GitHub when
available, or contact RowLow through the GitHub profile for `nurdthug`.

Please do not publish working exploits, leaked credentials, or private payment
material in a public issue.

## Scope

In scope:

- beacon or `.well-known` discovery poisoning
- payment address, amount, asset, network, or facilitator rebinding
- redirect or credential-bearing backend acceptance
- receipt verification inconsistencies
- accidental secret exposure

Out of scope:

- unpaid probes that correctly return HTTP 402
- temporary backend downtime
- speculative trading outcomes from a paid risk verdict

Crow Oracle sells machine-readable risk signals, not investment advice or
custody services.
