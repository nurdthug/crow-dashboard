import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXPECTED,
  buildBeacon,
  parseTemporaryBackend,
  probeOracle,
  syncFromUrlFile,
} from "../scripts/update-oracle-beacon.mjs";

const BASE_URL = "https://operated-repairs-zope-ricky.trycloudflare.com";
const TOKEN_RESOURCE = "/check/11111111111111111111111111111111";
const HEALTH_RESOURCE = "/health/11111111111111111111111111111111";

function jsonResponse(status, body) {
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "application/json" : null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function fixture(overrides = {}) {
  const quote = (resource, amount) => ({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: EXPECTED.catalogNetwork,
        resource,
        payTo: EXPECTED.payTo,
        tokenAccount: EXPECTED.tokenAccount,
        asset: EXPECTED.asset,
        maxAmountRequired: amount,
      },
    ],
  });
  return {
    health: {
      ok: true,
      service: EXPECTED.service,
      version: EXPECTED.version,
      network: EXPECTED.healthNetwork,
      ...overrides.health,
    },
    catalog: {
      schemaVersion: 1,
      service: EXPECTED.service,
      operator: EXPECTED.operator,
      version: EXPECTED.version,
      baseUrl: BASE_URL,
      network: EXPECTED.catalogNetwork,
      custody: "zero-key",
      payment: {
        protocol: "x402",
        wireVersion: 1,
        scheme: "exact",
        network: EXPECTED.catalogNetwork,
        requestHeader: "X-Payment",
        settlement: "direct-solana",
        compatibility: "legacy-x402-v1-direct-solana",
        bazaarIndexed: false,
        receipt: { serverSigned: false, verifier: { onChainChecks: false } },
        ...overrides.payment,
      },
      products: [
        {
          id: "token-risk-check",
          method: "GET",
          resourceTemplate: `${BASE_URL}/check/{mint}`,
          description: "Token risk verdict.",
          price: { amountUSDC: 0.03, amountBaseUnits: EXPECTED.tokenRiskAmount, asset: EXPECTED.asset },
          quoteStatus: 402,
        },
        {
          id: "lending-health",
          method: "GET",
          resourceTemplate: `${BASE_URL}/health/{wallet}`,
          description: "Lending health signal.",
          price: { amountUSDC: 0.05, amountBaseUnits: EXPECTED.lendingHealthAmount, asset: EXPECTED.asset },
          quoteStatus: 402,
        },
      ],
      ...overrides.catalog,
    },
    sample: {
      service: EXPECTED.service,
      sample: true,
      billable: false,
      ...overrides.sample,
    },
    tokenQuote: overrides.tokenQuote || quote(TOKEN_RESOURCE, EXPECTED.tokenRiskAmount),
    healthQuote: overrides.healthQuote || quote(HEALTH_RESOURCE, EXPECTED.lendingHealthAmount),
  };
}

function mockFetch(data) {
  return async function fetchImpl(url) {
    const value = String(url);
    if (value.endsWith("/healthz")) return jsonResponse(200, data.health);
    if (value.endsWith("/catalog.json")) return jsonResponse(200, data.catalog);
    if (value.endsWith("/sample/token-risk")) return jsonResponse(200, data.sample);
    if (value.endsWith(TOKEN_RESOURCE)) return jsonResponse(402, data.tokenQuote);
    if (value.endsWith(HEALTH_RESOURCE)) return jsonResponse(402, data.healthQuote);
    throw new Error(`unexpected URL ${value}`);
  };
}

test("temporary backend policy rejects unsafe origins", () => {
  assert.equal(parseTemporaryBackend(`${BASE_URL}/`), BASE_URL);
  assert.throws(() => parseTemporaryBackend("http://operated-repairs-zope-ricky.trycloudflare.com"));
  assert.throws(() => parseTemporaryBackend("https://buyer:secret@operated-repairs-zope-ricky.trycloudflare.com"));
  assert.throws(() => parseTemporaryBackend("https://operated-repairs-zope-ricky.trycloudflare.com/path"));
  assert.throws(() => parseTemporaryBackend("https://example.com"));
});

test("v1-only probe builds deterministic deployed beacon shape", async () => {
  const probe = await probeOracle(BASE_URL, { fetchImpl: mockFetch(fixture()) });
  const beacon = buildBeacon(probe, { updatedAt: "2026-08-15T07:48:35Z" });
  assert.equal(beacon.version, "0.3.11");
  assert.equal(beacon.payment.wireVersion, 1);
  assert.equal(beacon.payment.compatibility, "legacy-x402-v1-direct-solana");
  assert.equal(beacon.payment.settlement, "direct-solana");
  assert.equal(beacon.payment.bazaarIndexed, false);
  assert.equal(beacon.payment.standardV2, undefined);
  assert.equal(beacon.products.length, 2);
  assert.equal(beacon.docs.buyerClient, `${BASE_URL}/buyer-client.mjs`);
});

test("sync writes byte-identical primary and well-known beacons", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crow-beacon-v1-"));
  try {
    const urlFile = path.join(dir, "url");
    const output = path.join(dir, "oracle.json");
    const wellKnown = path.join(dir, ".well-known.json");
    await writeFile(urlFile, `${BASE_URL}\n`);
    await writeFile(output, JSON.stringify({ updatedAt: "2026-08-15T07:48:35Z" }));
    const result = await syncFromUrlFile({
      urlFile,
      output,
      wellKnown,
      fetchImpl: mockFetch(fixture()),
      now: () => new Date("2026-08-15T15:00:00.000Z"),
    });
    assert.equal(result.changed, true);
    assert.equal(await readFile(output, "utf8"), await readFile(wellKnown, "utf8"));
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.equal(written.version, EXPECTED.version);
    assert.equal(written.payment.standardV2, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v1 probe fails closed on version, standardV2, or quote rebinding", async () => {
  await assert.rejects(
    probeOracle(BASE_URL, { fetchImpl: mockFetch(fixture({ health: { version: "0.4.1" } })) }),
    /health version mismatch/,
  );
  await assert.rejects(
    probeOracle(BASE_URL, {
      fetchImpl: mockFetch(fixture({ payment: { standardV2: { wireVersion: 2 } } })),
    }),
    /unsupported standardV2/,
  );
  await assert.rejects(
    probeOracle(BASE_URL, {
      fetchImpl: mockFetch(
        fixture({
          tokenQuote: {
            x402Version: 1,
            accepts: [{ ...fixture().tokenQuote.accepts[0], payTo: "11111111111111111111111111111111" }],
          },
        }),
      ),
    }),
    /token-risk payTo mismatch/,
  );
});
