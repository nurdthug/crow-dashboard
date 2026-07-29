import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
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

function fixture(baseUrl, overrides = {}) {
  const catalog = {
    schemaVersion: 1,
    service: EXPECTED.service,
    operator: EXPECTED.operator,
    version: EXPECTED.version,
    baseUrl,
    network: EXPECTED.catalogNetwork,
    custody: "zero-key",
    revenueAccounting:
      "Only unique confirmed x402 settlement signatures count as Crow revenue.",
    docs: {
      openapi: `${baseUrl}/openapi.json`,
      llms: `${baseUrl}/llms.txt`,
      freeTokenRiskSample: `${baseUrl}/sample/token-risk`,
      buyerClient: `${baseUrl}/buyer-client.mjs`,
      receiptVerifier: `${baseUrl}/verify-receipt.mjs`,
      publicState: `${baseUrl}/state`,
    },
    products: [
      {
        id: "token-risk-check",
        method: "GET",
        resourceTemplate: `${baseUrl}/check/{mint}`,
        description: "Token risk verdict.",
        price: {
          amountUSDC: 0.03,
          amountBaseUnits: EXPECTED.tokenRiskAmount,
          asset: EXPECTED.asset,
        },
        quoteStatus: 402,
      },
      {
        id: "lending-health",
        method: "GET",
        resourceTemplate: `${baseUrl}/health/{wallet}`,
        description: "Lending position health.",
        price: {
          amountUSDC: 0.05,
          amountBaseUnits: EXPECTED.lendingHealthAmount,
          asset: EXPECTED.asset,
        },
        quoteStatus: 402,
      },
    ],
    payment: {
      protocol: "x402",
      wireVersion: 1,
      scheme: "exact",
      settlement: "direct-solana",
      bazaarIndexed: false,
      receipt: {
        serverSigned: false,
        verifier: { onChainChecks: false },
      },
    },
  };
  const health = {
    ok: true,
    service: EXPECTED.service,
    version: EXPECTED.version,
    network: EXPECTED.healthNetwork,
  };
  const sample = {
    service: EXPECTED.service,
    version: EXPECTED.version,
    sample: true,
    billable: false,
    liveChainQuery: false,
    buyerClient: `${baseUrl}/buyer-client.mjs`,
    receiptVerifier: `${baseUrl}/verify-receipt.mjs`,
  };
  const quote = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: EXPECTED.catalogNetwork,
        resource: "/check/11111111111111111111111111111111",
        payTo: EXPECTED.payTo,
        tokenAccount: EXPECTED.tokenAccount,
        asset: EXPECTED.asset,
        maxAmountRequired: EXPECTED.tokenRiskAmount,
      },
    ],
  };
  const lendingQuote = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: EXPECTED.catalogNetwork,
        resource: "/health/11111111111111111111111111111111",
        payTo: EXPECTED.payTo,
        tokenAccount: EXPECTED.tokenAccount,
        asset: EXPECTED.asset,
        maxAmountRequired: EXPECTED.lendingHealthAmount,
      },
    ],
  };
  return {
    health: { ...health, ...overrides.health },
    catalog: { ...catalog, ...overrides.catalog },
    sample: { ...sample, ...overrides.sample },
    quote: { ...quote, ...overrides.quote },
    lendingQuote: {
      ...lendingQuote,
      ...overrides.lendingQuote,
    },
  };
}

async function withFixtureServer(options, callback) {
  let baseUrl;
  const server = http.createServer((request, response) => {
    if (options.redirectHealth && request.url === "/healthz") {
      response.writeHead(302, { Location: "/redirected" });
      response.end();
      return;
    }
    const bodies = fixture(baseUrl, options.overrides);
    const routes = {
      "/healthz": [200, bodies.health],
      "/catalog.json": [200, bodies.catalog],
      "/sample/token-risk": [200, bodies.sample],
      "/check/11111111111111111111111111111111": [402, bodies.quote],
      "/health/11111111111111111111111111111111": [
        402,
        bodies.lendingQuote,
      ],
    };
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(route[0], { "Content-Type": "application/json" });
    response.end(JSON.stringify(route[1]));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `https://127.0.0.1:${address.port}`;
  const httpBaseUrl = `http://127.0.0.1:${address.port}`;

  const localFetch = (url, init) => {
    const rewritten = url.replace(baseUrl, httpBaseUrl);
    return fetch(rewritten, init);
  };

  try {
    return await callback({ baseUrl, fetchImpl: localFetch });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const localPolicy = {
  allowHostname: (hostname) => hostname === "127.0.0.1",
  allowPort: true,
};

test("valid live contract writes deterministic primary and well-known beacons", async () => {
  await withFixtureServer({}, async ({ baseUrl, fetchImpl }) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "crow-beacon-"));
    try {
      const urlFile = path.join(temp, "url");
      const output = path.join(temp, "oracle.json");
      const wellKnown = path.join(temp, ".well-known", "crow-oracle.json");
      await writeFile(urlFile, `${baseUrl}\n`);

      const first = await syncFromUrlFile({
        urlFile,
        output,
        wellKnown,
        fetchImpl,
        ...localPolicy,
        now: () => new Date("2026-07-29T12:00:00.000Z"),
      });
      assert.equal(first.changed, true);
      assert.equal(first.beacon.backend.baseUrl, baseUrl);
      assert.equal(first.beacon.payment.protocol, "x402");
      assert.equal(first.beacon.payment.compatibility, "legacy-x402-v1");
      assert.equal(first.beacon.payment.bazaarIndexed, false);
      assert.equal(first.beacon.payment.receipt.serverSigned, false);
      assert.equal(first.beacon.payment.receipt.onChainChecked, false);
      assert.equal(first.beacon.payment.payTo, EXPECTED.payTo);
      assert.equal(first.beacon.payment.tokenAccount, EXPECTED.tokenAccount);

      const primary = await readFile(output, "utf8");
      const mirror = await readFile(wellKnown, "utf8");
      assert.equal(primary, mirror);

      const second = await syncFromUrlFile({
        urlFile,
        output,
        wellKnown,
        fetchImpl,
        ...localPolicy,
        now: () => new Date("2026-07-30T12:00:00.000Z"),
      });
      assert.equal(second.changed, false);
      assert.equal(second.beacon.updatedAt, "2026-07-29T12:00:00.000Z");
      assert.equal(await readFile(output, "utf8"), primary);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

test("temporary host policy rejects malicious suffixes", () => {
  assert.throws(
    () =>
      parseTemporaryBackend(
        "https://safe.trycloudflare.com.evil.example",
      ),
    /temporary-host policy/,
  );
});

test("temporary host policy rejects credential-bearing URLs", () => {
  assert.throws(
    () =>
      parseTemporaryBackend(
        "https://user:secret@safe.trycloudflare.com",
      ),
    /temporary-host policy/,
  );
});

test("redirects fail closed", async () => {
  await withFixtureServer(
    { redirectHealth: true },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /health request failed/,
      );
    },
  );
});

test("unreachable backends fail without exposing the URL", async () => {
  await assert.rejects(
    probeOracle("https://valid.trycloudflare.com", {
      fetchImpl: async () => {
        throw new Error("network includes private details");
      },
    }),
    (error) => {
      assert.equal(error.message, "health request failed");
      return true;
    },
  );
});

test("service mismatches fail closed", async () => {
  await withFixtureServer(
    { overrides: { catalog: { service: "lookalike-oracle" } } },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /catalog service mismatch/,
      );
    },
  );
});

test("protocol mismatches fail closed", async () => {
  await withFixtureServer(
    {
      overrides: {
        catalog: {
          payment: {
            protocol: "x402",
            wireVersion: 2,
            scheme: "exact",
            settlement: "facilitator",
            bazaarIndexed: true,
            receipt: {
              serverSigned: true,
              verifier: { onChainChecks: true },
            },
          },
        },
      },
    },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /payment wire version mismatch/,
      );
    },
  );
});

test("pay-to rebinding fails closed", async () => {
  await withFixtureServer(
    {
      overrides: {
        quote: {
          accepts: [
            {
              scheme: "exact",
              network: EXPECTED.catalogNetwork,
              resource: "/check/11111111111111111111111111111111",
              payTo: "11111111111111111111111111111111",
              tokenAccount: EXPECTED.tokenAccount,
              asset: EXPECTED.asset,
              maxAmountRequired: EXPECTED.tokenRiskAmount,
            },
          ],
        },
      },
    },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /quote pay-to mismatch/,
      );
    },
  );
});

test("second-product quote rebinding fails closed", async () => {
  await withFixtureServer(
    {
      overrides: {
        lendingQuote: {
          accepts: [
            {
              scheme: "exact",
              network: EXPECTED.catalogNetwork,
              resource: "/health/11111111111111111111111111111111",
              payTo: EXPECTED.payTo,
              tokenAccount: EXPECTED.tokenAccount,
              asset: EXPECTED.asset,
              maxAmountRequired: "1",
            },
          ],
        },
      },
    },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /lending-health quote amount mismatch/,
      );
    },
  );
});

test("catalog product rebinding fails closed", async () => {
  await withFixtureServer(
    {
      overrides: {
        catalog: {
          products: [
            {
              id: "token-risk-check",
              method: "GET",
              resourceTemplate:
                "https://attacker.example/check/{mint}",
              description: "Token risk verdict.",
              price: {
                amountUSDC: 0.03,
                amountBaseUnits: EXPECTED.tokenRiskAmount,
                asset: EXPECTED.asset,
              },
              quoteStatus: 402,
            },
          ],
        },
      },
    },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /catalog products contract mismatch/,
      );
    },
  );
});

test("beacon construction is byte-deterministic for fixed evidence and time", async () => {
  await withFixtureServer({}, async ({ baseUrl, fetchImpl }) => {
    const probe = await probeOracle(baseUrl, {
      fetchImpl,
      ...localPolicy,
    });
    const first = JSON.stringify(
      buildBeacon(probe, { updatedAt: "2026-07-29T12:00:00.000Z" }),
    );
    const second = JSON.stringify(
      buildBeacon(probe, { updatedAt: "2026-07-29T12:00:00.000Z" }),
    );
    assert.equal(first, second);
  });
});
