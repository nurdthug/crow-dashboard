# Crow Oracle buyer quickstart

Crow Oracle lets a bot, dashboard, or agent buy one exact Solana answer without
an account, API key, subscription, or sales call.

The stable source of truth is the beacon:

```text
https://nurdthug.github.io/crow-dashboard/oracle.json
```

Always fetch the beacon first. The backend is advertised as temporary, so
production buyers should not hardcode the current backend hostname.

## Products

Read current product URLs and prices from `oracle.json`. At the time of this
repo update, the beacon advertises:

| Product | Use case | Current price |
| --- | --- | --- |
| `token-risk-check` | Red, amber, or green Solana token risk verdict with concise reasons. | `0.03 USDC` |
| `lending-health` | Kamino position health and liquidation-risk signals for a Solana wallet. | `0.05 USDC` |

## 1. Fetch discovery

```bash
curl -fsSL https://nurdthug.github.io/crow-dashboard/oracle.json
```

Check these fields before buying:

- `backend.baseUrl`
- `backend.health`
- `docs.catalog`
- `docs.freeSample`
- `docs.buyerClient`
- `docs.receiptVerifier`
- `products`
- `payment.wireVersion`
- `payment.compatibility`

## 2. Check live health

```bash
BEACON=https://nurdthug.github.io/crow-dashboard/oracle.json
HEALTH=$(node -e 'fetch(process.env.BEACON).then(r=>r.json()).then(j=>console.log(j.backend.health))')
curl -fsS "$HEALTH"
```

Expected shape:

```json
{"ok":true,"service":"crow-oracle","version":"0.3.11","network":"mainnet"}
```

If health fails, do not construct or transmit payment.

## 3. Try the free sample

```bash
SAMPLE=$(node -e 'fetch("https://nurdthug.github.io/crow-dashboard/oracle.json").then(r=>r.json()).then(j=>console.log(j.docs.freeSample))')
curl -fsS "$SAMPLE"
```

The sample shows the response shape. It is not billable and is not a live token
verdict.

Look for these fields before moving to payment:

```json
{
  "service": "crow-oracle",
  "sample": true,
  "billable": false,
  "liveChainQuery": false,
  "paidResourceTemplate": "https://<current-backend>/check/{mint}",
  "priceUSDC": 0.03
}
```

## 4. Get an unpaid quote

Token risk example:

```bash
MINT=11111111111111111111111111111111
BASE=$(node -e 'fetch("https://nurdthug.github.io/crow-dashboard/oracle.json").then(r=>r.json()).then(j=>console.log(j.backend.baseUrl))')
curl -i "$BASE/check/$MINT"
```

Lending health example:

```bash
WALLET=11111111111111111111111111111111
BASE=$(node -e 'fetch("https://nurdthug.github.io/crow-dashboard/oracle.json").then(r=>r.json()).then(j=>console.log(j.backend.baseUrl))')
curl -i "$BASE/health/$WALLET"
```

Expected result:

- HTTP `402`
- legacy x402 v1 quote body
- `x402Version` of `1`
- `payTo`, `tokenAccount`, `asset`, and `maxAmountRequired` matching the beacon
- `maxAmountRequired` of `30000` for token risk or `50000` for lending health

## 5. Pay the exact resource

1. Use the buyer client advertised by `docs.buyerClient`.
2. Validate the current unpaid quote against an already-signed exact SPL
   transfer.
3. Send the exact `X-Payment` header only after validation passes.
4. Save the paid JSON response and settlement signature.

## 6. Verify receipt

Use the verifier advertised by `docs.receiptVerifier`. Receipt verification is
deterministic and offline according to the current catalog.

Only unique confirmed x402 settlement signatures count as Crow revenue. Unpaid
probes, synthetic fixtures, wallet balances, and dashboard traffic do not.

## Integration offers

Good first integrations:

- Telegram or Discord `/risk <mint>` bot command.
- Wallet or token dashboard risk badge.
- Kamino lending-health monitor for a public wallet.
- x402 demo showing one machine-payable API purchase end to end.
