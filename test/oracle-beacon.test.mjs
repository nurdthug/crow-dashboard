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

const TOKEN_RISK_RESOURCE =
  "/check/11111111111111111111111111111111";
const LENDING_HEALTH_RESOURCE =
  "/health/11111111111111111111111111111111";

function v2Challenge(baseUrl, resource, amount) {
  return {
    x402Version: 2,
    resource: {
      url: `${baseUrl}${resource}`,
      description: "Crow Oracle paid result.",
      mimeType: "application/json",
      serviceName: "Crow Oracle",
      tags: ["solana", "risk", "x402"],
    },
    accepts: [
      {
        scheme: "exact",
        network: EXPECTED.v2Network,
        amount,
        asset: EXPECTED.asset,
        payTo: EXPECTED.payTo,
        maxTimeoutSeconds: EXPECTED.v2MaxTimeoutSeconds,
        extra: {
          feePayer: EXPECTED.v2FeePayer,
        },
      },
    ],
  };
}

function encodePaymentRequired(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(text, "utf8").toString("base64");
}

function configuredPaymentHeader(options, key, challenge) {
  if (!Object.hasOwn(options, key)) {
    return encodePaymentRequired(challenge);
  }
  const configured = options[key];
  if (configured === null) return null;
  const resolved =
    typeof configured === "function"
      ? configured(structuredClone(challenge))
      : configured;
  if (resolved === null) return null;
  if (typeof resolved === "object") {
    return encodePaymentRequired(resolved);
  }
  return resolved;
}

function fixture(baseUrl, overrides = {}) {
  const standardV2 = {
    wireVersion: 2,
    scheme: "exact",
    network: EXPECTED.v2Network,
    challengeHeader: "PAYMENT-REQUIRED",
    requestHeader: "PAYMENT-SIGNATURE",
    responseHeader: "PAYMENT-RESPONSE",
    specificationCommit: EXPECTED.v2SpecificationCommit,
    facilitator: {
      origin: EXPECTED.v2FacilitatorOrigin,
      accountRequired: false,
      credentialRequired: false,
      gasSponsored: true,
      redirectsAccepted: false,
      capabilityCheckedBeforeQuote: true,
    },
    retry: {
      policy: "same-payment-same-resource-redelivery",
      exactHeaderRequired: true,
      secondSale: false,
    },
    receiptVerification: {
      verifier: `${baseUrl}/verify-receipt.mjs`,
      networkCalls: false,
      onChainChecks: false,
    },
    bazaarIndexed: false,
    ...overrides.standardV2,
  };
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
      network: EXPECTED.catalogNetwork,
      requestHeader: "X-Payment",
      settlement: "direct-solana",
      standardV2,
      bazaarIndexed: false,
      compatibility: EXPECTED.compatibility,
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
        resource: TOKEN_RISK_RESOURCE,
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
        resource: LENDING_HEALTH_RESOURCE,
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
    tokenRiskV2: v2Challenge(
      baseUrl,
      TOKEN_RISK_RESOURCE,
      EXPECTED.tokenRiskAmount,
    ),
    lendingHealthV2: v2Challenge(
      baseUrl,
      LENDING_HEALTH_RESOURCE,
      EXPECTED.lendingHealthAmount,
    ),
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
    const tokenRiskHeader = configuredPaymentHeader(
      options,
      "tokenRiskPaymentRequired",
      bodies.tokenRiskV2,
    );
    const lendingHealthHeader = configuredPaymentHeader(
      options,
      "lendingHealthPaymentRequired",
      bodies.lendingHealthV2,
    );
    const routes = {
      "/healthz": [200, bodies.health],
      "/catalog.json": [200, bodies.catalog],
      "/sample/token-risk": [200, bodies.sample],
      [TOKEN_RISK_RESOURCE]: [402, bodies.quote, tokenRiskHeader],
      [LENDING_HEALTH_RESOURCE]: [
        402,
        bodies.lendingQuote,
        lendingHealthHeader,
      ],
    };
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    const headers = { "Content-Type": "application/json" };
    if (route[2] !== null && route[2] !== undefined) {
      headers["PAYMENT-REQUIRED"] = route[2];
    }
    response.writeHead(route[0], headers);
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

test("valid dual live contract writes deterministic beacons", async () => {
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
      assert.equal(
        first.beacon.payment.compatibility,
        "parallel-x402-v2-and-legacy-v1",
      );
      assert.equal(first.beacon.payment.wireVersion, 1);
      assert.equal(first.beacon.payment.payTo, EXPECTED.payTo);
      assert.equal(
        first.beacon.payment.tokenAccount,
        EXPECTED.tokenAccount,
      );
      assert.equal(first.beacon.payment.bazaarIndexed, false);
      assert.equal(first.beacon.payment.receipt.serverSigned, false);
      assert.equal(first.beacon.payment.receipt.onChainChecked, false);

      const v2 = first.beacon.payment.standardV2;
      assert.equal(v2.wireVersion, 2);
      assert.equal(v2.network, EXPECTED.v2Network);
      assert.equal(v2.challengeHeader, "PAYMENT-REQUIRED");
      assert.equal(v2.requestHeader, "PAYMENT-SIGNATURE");
      assert.equal(v2.responseHeader, "PAYMENT-RESPONSE");
      assert.equal(
        v2.specificationCommit,
        EXPECTED.v2SpecificationCommit,
      );
      assert.equal(v2.payTo, EXPECTED.payTo);
      assert.equal(v2.asset, EXPECTED.asset);
      assert.equal(v2.maxTimeoutSeconds, 300);
      assert.equal(
        v2.facilitator.origin,
        EXPECTED.v2FacilitatorOrigin,
      );
      assert.equal(v2.facilitator.feePayer, EXPECTED.v2FeePayer);
      assert.equal(v2.facilitator.accountRequired, false);
      assert.equal(v2.facilitator.credentialRequired, false);
      assert.equal(v2.facilitator.gasSponsored, true);
      assert.equal(v2.facilitator.redirectsAccepted, false);
      assert.equal(v2.receipt.networkCalls, false);
      assert.equal(v2.receipt.onChainChecked, false);
      assert.equal(v2.receipt.serverSigned, false);
      assert.equal(v2.bazaarIndexed, false);

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

test("contract changes refresh the timestamp and both mirrors", async () => {
  await withFixtureServer({}, async ({ baseUrl, fetchImpl }) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "crow-beacon-"));
    try {
      const urlFile = path.join(temp, "url");
      const output = path.join(temp, "oracle.json");
      const wellKnown = path.join(temp, ".well-known", "crow-oracle.json");
      await writeFile(urlFile, `${baseUrl}\n`);

      await syncFromUrlFile({
        urlFile,
        output,
        wellKnown,
        fetchImpl,
        ...localPolicy,
        now: () => new Date("2026-07-29T12:00:00.000Z"),
      });
      const stale = JSON.parse(await readFile(output, "utf8"));
      stale.payment.compatibility = "legacy-x402-v1";
      const staleText = `${JSON.stringify(stale, null, 2)}\n`;
      await writeFile(output, staleText);
      await writeFile(wellKnown, staleText);

      const refreshed = await syncFromUrlFile({
        urlFile,
        output,
        wellKnown,
        fetchImpl,
        ...localPolicy,
        now: () => new Date("2026-07-30T12:00:00.000Z"),
      });
      assert.equal(refreshed.changed, true);
      assert.equal(
        refreshed.beacon.updatedAt,
        "2026-07-30T12:00:00.000Z",
      );
      assert.equal(
        await readFile(output, "utf8"),
        await readFile(wellKnown, "utf8"),
      );
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

test("legacy protocol mismatches fail closed", async () => {
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

test("catalog v2 facilitator rebinding fails closed", async () => {
  await withFixtureServer(
    {
      overrides: {
        standardV2: {
          facilitator: {
            origin: "https://attacker.example",
            accountRequired: false,
            credentialRequired: false,
            gasSponsored: true,
            redirectsAccepted: false,
            capabilityCheckedBeforeQuote: true,
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
        /standard v2 facilitator origin mismatch/,
      );
    },
  );
});

test("legacy pay-to rebinding fails closed", async () => {
  await withFixtureServer(
    {
      overrides: {
        quote: {
          accepts: [
            {
              scheme: "exact",
              network: EXPECTED.catalogNetwork,
              resource: TOKEN_RISK_RESOURCE,
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

test("legacy second-product quote rebinding fails closed", async () => {
  await withFixtureServer(
    {
      overrides: {
        lendingQuote: {
          accepts: [
            {
              scheme: "exact",
              network: EXPECTED.catalogNetwork,
              resource: LENDING_HEALTH_RESOURCE,
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

test("missing v2 challenge fails closed", async () => {
  await withFixtureServer(
    { tokenRiskPaymentRequired: null },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /PAYMENT-REQUIRED header is missing/,
      );
    },
  );
});

test("malformed v2 base64 fails closed", async () => {
  await withFixtureServer(
    { tokenRiskPaymentRequired: "not canonical base64!" },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /not canonical base64/,
      );
    },
  );
});

test("duplicate v2 JSON fields fail closed", async () => {
  await withFixtureServer(
    {
      tokenRiskPaymentRequired: (challenge) => {
        const duplicate = JSON.stringify(challenge).replace(
          '"x402Version":2',
          '"x402Version":2,"x402Version":2',
        );
        return encodePaymentRequired(duplicate);
      },
    },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /duplicate field/,
      );
    },
  );
});

const v2RebindingCases = [
  [
    "resource URL",
    (challenge) => {
      challenge.resource.url =
        "https://attacker.example/check/11111111111111111111111111111111";
      return challenge;
    },
    /v2 resource URL mismatch/,
  ],
  [
    "amount",
    (challenge) => {
      challenge.accepts[0].amount = "1";
      return challenge;
    },
    /v2 amount mismatch/,
  ],
  [
    "merchant",
    (challenge) => {
      challenge.accepts[0].payTo =
        "11111111111111111111111111111111";
      return challenge;
    },
    /v2 pay-to mismatch/,
  ],
  [
    "asset",
    (challenge) => {
      challenge.accepts[0].asset =
        "So11111111111111111111111111111111111111112";
      return challenge;
    },
    /v2 asset mismatch/,
  ],
  [
    "network",
    (challenge) => {
      challenge.accepts[0].network = "solana:devnet";
      return challenge;
    },
    /v2 network mismatch/,
  ],
  [
    "fee payer",
    (challenge) => {
      challenge.accepts[0].extra.feePayer =
        "11111111111111111111111111111111";
      return challenge;
    },
    /v2 fee payer mismatch/,
  ],
];

for (const [name, mutate, expectedError] of v2RebindingCases) {
  test(`v2 ${name} rebinding fails closed`, async () => {
    await withFixtureServer(
      { tokenRiskPaymentRequired: mutate },
      async ({ baseUrl, fetchImpl }) => {
        await assert.rejects(
          probeOracle(baseUrl, {
            fetchImpl,
            ...localPolicy,
          }),
          expectedError,
        );
      },
    );
  });
}

test("second-product v2 rebinding fails closed", async () => {
  await withFixtureServer(
    {
      lendingHealthPaymentRequired: (challenge) => {
        challenge.accepts[0].amount = EXPECTED.tokenRiskAmount;
        return challenge;
      },
    },
    async ({ baseUrl, fetchImpl }) => {
      await assert.rejects(
        probeOracle(baseUrl, {
          fetchImpl,
          ...localPolicy,
        }),
        /lending-health v2 amount mismatch/,
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
