#!/usr/bin/env node

import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");

export const EXPECTED = Object.freeze({
  version: "0.4.0",
  service: "crow-oracle",
  operator: "RowLow",
  healthNetwork: "mainnet",
  catalogNetwork: "solana-mainnet",
  v2Network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  v2SpecificationCommit:
    "895f3505a6c0beb767555344cb97130c3da7c8b2",
  v2FacilitatorOrigin: "https://x402.dexter.cash",
  v2FeePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8",
  v2MaxTimeoutSeconds: 300,
  payTo: "AxaEvPSnYhDALmxordg2zzqZxEoALrQpt17ZL8CsGsNh",
  tokenAccount: "4W7xRpvGz1mqtVANNrRWHR3KAVMcc1LQrooym2weTbh5",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  tokenRiskAmount: "30000",
  lendingHealthAmount: "50000",
  stableOrigin: "https://nurdthug.github.io/crow-dashboard",
  compatibility:
    "Parallel contracts: standards-conformant x402 v2 exact Solana through the fixed public Dexter facilitator, plus the preserved legacy x402 v1 direct-settlement path.",
});

const MAX_JSON_BYTES = 1_000_000;
const MAX_HEADER_BYTES = 256 * 1024;
const QUOTE_RESOURCES = Object.freeze({
  tokenRisk: "/check/11111111111111111111111111111111",
  lendingHealth: "/health/11111111111111111111111111111111",
});

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireExactKeys(value, expected, label) {
  const object = requirePlainObject(value, label);
  const actual = Object.keys(object).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    fail(`${label} fields mismatch`);
  }
  return object;
}

function parseJsonStructure(text) {
  let index = 0;
  let depth = 0;

  const malformed = () => fail("JSON is malformed");
  const whitespace = () => {
    while (
      index < text.length &&
      (text[index] === " " ||
        text[index] === "\n" ||
        text[index] === "\r" ||
        text[index] === "\t")
    ) {
      index += 1;
    }
  };
  const string = () => {
    if (text[index] !== '"') malformed();
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) malformed();
      if (text[index] === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          malformed();
        }
      }
      if (text[index] === "\\") {
        index += 1;
        if (index >= text.length) malformed();
        if (text[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
            malformed();
          }
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(text[index])) malformed();
      }
      index += 1;
    }
    malformed();
  };
  const value = () => {
    whitespace();
    const character = text[index];
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') {
      string();
      return;
    }
    const literal = text.slice(index);
    const number = literal.match(
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/,
    );
    if (number) {
      index += number[0].length;
      return;
    }
    for (const token of ["true", "false", "null"]) {
      if (literal.startsWith(token)) {
        index += token.length;
        return;
      }
    }
    malformed();
  };
  const object = () => {
    depth += 1;
    if (depth > 64) malformed();
    index += 1;
    whitespace();
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      depth -= 1;
      return;
    }
    while (index < text.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) fail("JSON contains a duplicate field");
      keys.add(key);
      whitespace();
      if (text[index] !== ":") malformed();
      index += 1;
      value();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        depth -= 1;
        return;
      }
      if (text[index] !== ",") malformed();
      index += 1;
    }
    malformed();
  };
  const array = () => {
    depth += 1;
    if (depth > 64) malformed();
    index += 1;
    whitespace();
    if (text[index] === "]") {
      index += 1;
      depth -= 1;
      return;
    }
    while (index < text.length) {
      value();
      whitespace();
      if (text[index] === "]") {
        index += 1;
        depth -= 1;
        return;
      }
      if (text[index] !== ",") malformed();
      index += 1;
    }
    malformed();
  };

  whitespace();
  value();
  whitespace();
  if (index !== text.length) malformed();
}

function parseStrictJson(text, maxBytes) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > maxBytes
  ) {
    fail("JSON is invalid or oversized");
  }
  parseJsonStructure(text);
  try {
    return JSON.parse(text);
  } catch {
    fail("JSON is malformed");
  }
}

function decodePaymentRequiredHeader(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > Math.ceil((MAX_HEADER_BYTES * 4) / 3) + 4 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    fail(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  const padded = bytes.toString("base64");
  if (
    bytes.length > MAX_HEADER_BYTES ||
    (value !== padded && value !== padded.replace(/=+$/, ""))
  ) {
    fail(`${label} is not canonical base64`);
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not UTF-8 JSON`);
  }
  return parseStrictJson(text, MAX_HEADER_BYTES);
}

export function isTryCloudflareHostname(hostname) {
  const suffix = ".trycloudflare.com";
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

export function parseTemporaryBackend(
  raw,
  {
    allowHostname = isTryCloudflareHostname,
    allowPort = false,
  } = {},
) {
  if (typeof raw !== "string" || raw.length > 2048) {
    fail("backend URL is invalid");
  }

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    fail("backend URL is invalid");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    (!allowPort && parsed.port) ||
    !allowHostname(parsed.hostname)
  ) {
    fail("backend URL violates the temporary-host policy");
  }

  return parsed.origin;
}

async function fetchJson(
  fetchImpl,
  url,
  label,
  expectedStatus = 200,
) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "crow-oracle-beacon/1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail(`${label} request failed`);
  }

  if (response.status !== expectedStatus) {
    fail(`${label} returned unexpected status`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    fail(`${label} did not return JSON`);
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    fail(`${label} response is too large`);
  }
  let json;
  try {
    json = parseStrictJson(text, MAX_JSON_BYTES);
  } catch {
    fail(`${label} returned malformed JSON`);
  }
  return { json, headers: response.headers };
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} mismatch`);
}

function requireUrl(actual, expected, label) {
  requireEqual(actual, expected, label);
}

function validateHealth(health) {
  requireEqual(health?.ok, true, "health ok");
  requireEqual(health?.service, EXPECTED.service, "health service");
  requireEqual(health?.version, EXPECTED.version, "health version");
  requireEqual(health?.network, EXPECTED.healthNetwork, "health network");
}

function validateCatalog(catalog, baseUrl) {
  requireEqual(catalog?.schemaVersion, 1, "catalog schema");
  requireEqual(catalog?.service, EXPECTED.service, "catalog service");
  requireEqual(catalog?.operator, EXPECTED.operator, "catalog operator");
  requireEqual(catalog?.version, EXPECTED.version, "catalog version");
  requireEqual(catalog?.baseUrl, baseUrl, "catalog base URL");
  requireEqual(catalog?.network, EXPECTED.catalogNetwork, "catalog network");
  requireEqual(catalog?.custody, "zero-key", "catalog custody");
  requireEqual(catalog?.payment?.protocol, "x402", "payment protocol");
  requireEqual(catalog?.payment?.wireVersion, 1, "payment wire version");
  requireEqual(catalog?.payment?.scheme, "exact", "payment scheme");
  requireEqual(
    catalog?.payment?.network,
    EXPECTED.catalogNetwork,
    "payment network",
  );
  requireEqual(
    catalog?.payment?.requestHeader,
    "X-Payment",
    "payment request header",
  );
  requireEqual(
    catalog?.payment?.settlement,
    "direct-solana",
    "payment settlement",
  );
  requireEqual(catalog?.payment?.receipt?.serverSigned, false, "receipt signing");
  requireEqual(
    catalog?.payment?.receipt?.verifier?.onChainChecks,
    false,
    "receipt on-chain label",
  );
  requireEqual(
    catalog?.payment?.bazaarIndexed,
    false,
    "Bazaar label",
  );
  requireEqual(
    catalog?.payment?.compatibility,
    EXPECTED.compatibility,
    "payment compatibility",
  );

  const standardV2 = requirePlainObject(
    catalog?.payment?.standardV2,
    "standard v2 contract",
  );
  requireEqual(standardV2.wireVersion, 2, "standard v2 wire version");
  requireEqual(standardV2.scheme, "exact", "standard v2 scheme");
  requireEqual(
    standardV2.network,
    EXPECTED.v2Network,
    "standard v2 network",
  );
  requireEqual(
    standardV2.challengeHeader,
    "PAYMENT-REQUIRED",
    "standard v2 challenge header",
  );
  requireEqual(
    standardV2.requestHeader,
    "PAYMENT-SIGNATURE",
    "standard v2 request header",
  );
  requireEqual(
    standardV2.responseHeader,
    "PAYMENT-RESPONSE",
    "standard v2 response header",
  );
  requireEqual(
    standardV2.specificationCommit,
    EXPECTED.v2SpecificationCommit,
    "standard v2 specification commit",
  );
  const facilitator = requirePlainObject(
    standardV2.facilitator,
    "standard v2 facilitator",
  );
  requireEqual(
    facilitator.origin,
    EXPECTED.v2FacilitatorOrigin,
    "standard v2 facilitator origin",
  );
  requireEqual(
    facilitator.accountRequired,
    false,
    "standard v2 account requirement",
  );
  requireEqual(
    facilitator.credentialRequired,
    false,
    "standard v2 credential requirement",
  );
  requireEqual(
    facilitator.gasSponsored,
    true,
    "standard v2 gas sponsorship",
  );
  requireEqual(
    facilitator.redirectsAccepted,
    false,
    "standard v2 redirect policy",
  );
  requireEqual(
    facilitator.capabilityCheckedBeforeQuote,
    true,
    "standard v2 capability check",
  );
  requireEqual(
    standardV2?.retry?.policy,
    "same-payment-same-resource-redelivery",
    "standard v2 retry policy",
  );
  requireEqual(
    standardV2?.retry?.exactHeaderRequired,
    true,
    "standard v2 retry header binding",
  );
  requireEqual(
    standardV2?.retry?.secondSale,
    false,
    "standard v2 second-sale label",
  );
  requireEqual(
    standardV2?.receiptVerification?.verifier,
    `${baseUrl}/verify-receipt.mjs`,
    "standard v2 receipt verifier",
  );
  requireEqual(
    standardV2?.receiptVerification?.networkCalls,
    false,
    "standard v2 receipt network label",
  );
  requireEqual(
    standardV2?.receiptVerification?.onChainChecks,
    false,
    "standard v2 receipt on-chain label",
  );
  requireEqual(
    standardV2.bazaarIndexed,
    false,
    "standard v2 Bazaar label",
  );

  const expectedDocs = {
    openapi: `${baseUrl}/openapi.json`,
    llms: `${baseUrl}/llms.txt`,
    freeTokenRiskSample: `${baseUrl}/sample/token-risk`,
    buyerClient: `${baseUrl}/buyer-client.mjs`,
    receiptVerifier: `${baseUrl}/verify-receipt.mjs`,
    publicState: `${baseUrl}/state`,
  };
  for (const [key, value] of Object.entries(expectedDocs)) {
    requireUrl(catalog?.docs?.[key], value, `catalog docs ${key}`);
  }

  const expectedProducts = [
    {
      id: "token-risk-check",
      resourceTemplate: `${baseUrl}/check/{mint}`,
      amountUSDC: 0.03,
      amountBaseUnits: EXPECTED.tokenRiskAmount,
    },
    {
      id: "lending-health",
      resourceTemplate: `${baseUrl}/health/{wallet}`,
      amountUSDC: 0.05,
      amountBaseUnits: EXPECTED.lendingHealthAmount,
    },
  ];
  if (
    !Array.isArray(catalog?.products) ||
    catalog.products.length !== expectedProducts.length
  ) {
    fail("catalog products contract mismatch");
  }
  for (const expected of expectedProducts) {
    const product = catalog.products.find(({ id }) => id === expected.id);
    if (
      product?.method !== "GET" ||
      product?.resourceTemplate !== expected.resourceTemplate ||
      typeof product?.description !== "string" ||
      !product.description ||
      product?.price?.amountUSDC !== expected.amountUSDC ||
      product?.price?.amountBaseUnits !== expected.amountBaseUnits ||
      product?.price?.asset !== EXPECTED.asset ||
      product?.quoteStatus !== 402
    ) {
      fail("catalog product contract mismatch");
    }
  }
}

function validateSample(sample, baseUrl) {
  requireEqual(sample?.service, EXPECTED.service, "sample service");
  requireEqual(sample?.version, EXPECTED.version, "sample version");
  requireEqual(sample?.sample, true, "sample marker");
  requireEqual(sample?.billable, false, "sample billing label");
  requireEqual(sample?.liveChainQuery, false, "sample live-query label");
  requireUrl(
    sample?.buyerClient,
    `${baseUrl}/buyer-client.mjs`,
    "sample buyer client",
  );
  requireUrl(
    sample?.receiptVerifier,
    `${baseUrl}/verify-receipt.mjs`,
    "sample receipt verifier",
  );
}

function validateQuote(quote, resource, amount, label) {
  requireEqual(quote?.x402Version, 1, "quote wire version");
  if (!Array.isArray(quote?.accepts) || quote.accepts.length !== 1) {
    fail("quote accepts contract mismatch");
  }
  const accepted = quote.accepts[0];
  requireEqual(accepted?.scheme, "exact", "quote scheme");
  requireEqual(accepted?.network, EXPECTED.catalogNetwork, "quote network");
  requireEqual(accepted?.resource, resource, `${label} quote resource`);
  requireEqual(accepted?.payTo, EXPECTED.payTo, "quote pay-to");
  requireEqual(
    accepted?.tokenAccount,
    EXPECTED.tokenAccount,
    "quote token account",
  );
  requireEqual(accepted?.asset, EXPECTED.asset, "quote asset");
  requireEqual(
    accepted?.maxAmountRequired,
    amount,
    `${label} quote amount`,
  );
}

function validateV2Challenge(header, baseUrl, resource, amount, label) {
  if (header === null) fail(`${label} PAYMENT-REQUIRED header is missing`);
  const challenge = decodePaymentRequiredHeader(
    header,
    `${label} PAYMENT-REQUIRED header`,
  );
  requireExactKeys(
    challenge,
    ["x402Version", "resource", "accepts"],
    `${label} v2 challenge`,
  );
  requireEqual(challenge.x402Version, 2, `${label} v2 wire version`);

  const advertisedResource = requireExactKeys(
    challenge.resource,
    ["url", "description", "mimeType", "serviceName", "tags"],
    `${label} v2 resource`,
  );
  requireEqual(
    advertisedResource.url,
    `${baseUrl}${resource}`,
    `${label} v2 resource URL`,
  );
  if (
    typeof advertisedResource.description !== "string" ||
    !advertisedResource.description
  ) {
    fail(`${label} v2 resource description mismatch`);
  }
  requireEqual(
    advertisedResource.mimeType,
    "application/json",
    `${label} v2 resource MIME type`,
  );
  requireEqual(
    advertisedResource.serviceName,
    "Crow Oracle",
    `${label} v2 service name`,
  );
  if (
    !Array.isArray(advertisedResource.tags) ||
    advertisedResource.tags.length !== 3 ||
    advertisedResource.tags[0] !== "solana" ||
    advertisedResource.tags[1] !== "risk" ||
    advertisedResource.tags[2] !== "x402"
  ) {
    fail(`${label} v2 resource tags mismatch`);
  }

  if (!Array.isArray(challenge.accepts) || challenge.accepts.length !== 1) {
    fail(`${label} v2 accepts contract mismatch`);
  }
  const accepted = requireExactKeys(
    challenge.accepts[0],
    [
      "scheme",
      "network",
      "amount",
      "asset",
      "payTo",
      "maxTimeoutSeconds",
      "extra",
    ],
    `${label} v2 payment requirement`,
  );
  requireEqual(accepted.scheme, "exact", `${label} v2 scheme`);
  requireEqual(
    accepted.network,
    EXPECTED.v2Network,
    `${label} v2 network`,
  );
  requireEqual(accepted.amount, amount, `${label} v2 amount`);
  requireEqual(accepted.asset, EXPECTED.asset, `${label} v2 asset`);
  requireEqual(accepted.payTo, EXPECTED.payTo, `${label} v2 pay-to`);
  requireEqual(
    accepted.maxTimeoutSeconds,
    EXPECTED.v2MaxTimeoutSeconds,
    `${label} v2 timeout`,
  );
  const extra = requireExactKeys(
    accepted.extra,
    ["feePayer"],
    `${label} v2 extra`,
  );
  requireEqual(
    extra.feePayer,
    EXPECTED.v2FeePayer,
    `${label} v2 fee payer`,
  );
  return challenge;
}

export async function probeOracle(
  rawBaseUrl,
  {
    fetchImpl = fetch,
    allowHostname,
    allowPort,
  } = {},
) {
  const baseUrl = parseTemporaryBackend(rawBaseUrl, {
    allowHostname,
    allowPort,
  });
  const [
    healthResponse,
    catalogResponse,
    sampleResponse,
    tokenRiskResponse,
    lendingHealthResponse,
  ] =
    await Promise.all([
    fetchJson(fetchImpl, `${baseUrl}/healthz`, "health"),
    fetchJson(fetchImpl, `${baseUrl}/catalog.json`, "catalog"),
    fetchJson(fetchImpl, `${baseUrl}/sample/token-risk`, "sample"),
    fetchJson(
      fetchImpl,
      `${baseUrl}${QUOTE_RESOURCES.tokenRisk}`,
      "token-risk unpaid quote",
      402,
    ),
    fetchJson(
      fetchImpl,
      `${baseUrl}${QUOTE_RESOURCES.lendingHealth}`,
      "lending-health unpaid quote",
      402,
    ),
  ]);

  const health = healthResponse.json;
  const catalog = catalogResponse.json;
  const sample = sampleResponse.json;
  const tokenRiskQuote = tokenRiskResponse.json;
  const lendingHealthQuote = lendingHealthResponse.json;
  validateHealth(health);
  validateCatalog(catalog, baseUrl);
  validateSample(sample, baseUrl);
  validateQuote(
    tokenRiskQuote,
    QUOTE_RESOURCES.tokenRisk,
    EXPECTED.tokenRiskAmount,
    "token-risk",
  );
  validateQuote(
    lendingHealthQuote,
    QUOTE_RESOURCES.lendingHealth,
    EXPECTED.lendingHealthAmount,
    "lending-health",
  );
  const tokenRiskV2 = validateV2Challenge(
    tokenRiskResponse.headers.get("payment-required"),
    baseUrl,
    QUOTE_RESOURCES.tokenRisk,
    EXPECTED.tokenRiskAmount,
    "token-risk",
  );
  const lendingHealthV2 = validateV2Challenge(
    lendingHealthResponse.headers.get("payment-required"),
    baseUrl,
    QUOTE_RESOURCES.lendingHealth,
    EXPECTED.lendingHealthAmount,
    "lending-health",
  );
  return {
    baseUrl,
    health,
    catalog,
    sample,
    quotes: {
      tokenRisk: {
        legacyV1: tokenRiskQuote,
        standardV2: tokenRiskV2,
      },
      lendingHealth: {
        legacyV1: lendingHealthQuote,
        standardV2: lendingHealthV2,
      },
    },
  };
}

function publicProduct(product) {
  return {
    id: product.id,
    method: product.method,
    resourceTemplate: product.resourceTemplate,
    description: product.description,
    price: {
      amountUSDC: product.price.amountUSDC,
      amountBaseUnits: product.price.amountBaseUnits,
      asset: product.price.asset,
    },
    quoteStatus: product.quoteStatus,
  };
}

export function buildBeacon(
  probe,
  {
    updatedAt = new Date().toISOString(),
  } = {},
) {
  const { baseUrl, catalog, quotes } = probe;
  const accepted = quotes.tokenRisk.legacyV1.accepts[0];
  const acceptedV2 = quotes.tokenRisk.standardV2.accepts[0];
  const standardV2 = catalog.payment.standardV2;
  return {
    schemaVersion: 1,
    service: EXPECTED.service,
    operator: EXPECTED.operator,
    version: EXPECTED.version,
    stableOrigin: EXPECTED.stableOrigin,
    stableBeacon: `${EXPECTED.stableOrigin}/oracle.json`,
    updatedAt,
    backend: {
      baseUrl,
      hostnameClass: "temporary-accountless-cloudflare",
      permanent: false,
      health: `${baseUrl}/healthz`,
      buyerRequirement:
        "Fetch this beacon, then recheck backend health and the live unpaid quote before signing or transmitting payment.",
    },
    network: EXPECTED.catalogNetwork,
    custody: "zero-key",
    revenueAccounting:
      "Only unique confirmed x402 settlement signatures count as Crow revenue.",
    payment: {
      protocol: "x402",
      wireVersion: 1,
      scheme: "exact",
      settlement: "direct-solana",
      compatibility: "parallel-x402-v2-and-legacy-v1",
      bazaarIndexed: false,
      payTo: accepted.payTo,
      tokenAccount: accepted.tokenAccount,
      asset: accepted.asset,
      standardV2: {
        wireVersion: 2,
        scheme: "exact",
        network: standardV2.network,
        challengeHeader: standardV2.challengeHeader,
        requestHeader: standardV2.requestHeader,
        responseHeader: standardV2.responseHeader,
        specificationCommit: standardV2.specificationCommit,
        payTo: acceptedV2.payTo,
        asset: acceptedV2.asset,
        maxTimeoutSeconds: acceptedV2.maxTimeoutSeconds,
        facilitator: {
          origin: standardV2.facilitator.origin,
          feePayer: acceptedV2.extra.feePayer,
          accountRequired: standardV2.facilitator.accountRequired,
          credentialRequired: standardV2.facilitator.credentialRequired,
          gasSponsored: standardV2.facilitator.gasSponsored,
          redirectsAccepted: standardV2.facilitator.redirectsAccepted,
          capabilityCheckedBeforeQuote:
            standardV2.facilitator.capabilityCheckedBeforeQuote,
        },
        retry: {
          policy: standardV2.retry.policy,
          exactHeaderRequired: standardV2.retry.exactHeaderRequired,
          secondSale: standardV2.retry.secondSale,
        },
        receipt: {
          networkCalls: standardV2.receiptVerification.networkCalls,
          onChainChecked:
            standardV2.receiptVerification.onChainChecks,
          serverSigned: false,
        },
        bazaarIndexed: false,
      },
      receipt: {
        attestation: "deterministic-integrity",
        serverSigned: false,
        onChainChecked: false,
      },
    },
    docs: {
      catalog: `${baseUrl}/catalog.json`,
      openapi: `${baseUrl}/openapi.json`,
      llms: `${baseUrl}/llms.txt`,
      freeSample: `${baseUrl}/sample/token-risk`,
      buyerClient: `${baseUrl}/buyer-client.mjs`,
      receiptVerifier: `${baseUrl}/verify-receipt.mjs`,
      publicState: `${baseUrl}/state`,
    },
    products: catalog.products.map(publicProduct),
    integrity: {
      publisher: "nurdthug/crow-dashboard",
      publication:
        "Authenticated GitHub repository update after live health, catalog, sample, and unpaid-quote validation.",
      redirectPolicy: "reject",
      credentialBearingBackendUrls: "reject",
    },
  };
}

async function readExisting(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writeIfChanged(filePath, text) {
  try {
    if ((await readFile(filePath, "utf8")) === text) return false;
  } catch {
    // Missing or unreadable output is replaced atomically.
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, text, { encoding: "utf8", mode: 0o644 });
  await rename(tempPath, filePath);
  return true;
}

export async function syncFromUrlFile({
  urlFile,
  output,
  wellKnown,
  fetchImpl = fetch,
  allowHostname,
  allowPort,
  now = () => new Date(),
  checkOnly = false,
}) {
  const rawBaseUrl = await readFile(urlFile, "utf8");
  const probe = await probeOracle(rawBaseUrl, {
    fetchImpl,
    allowHostname,
    allowPort,
  });
  const existing = await readExisting(output);
  let beacon = null;
  if (typeof existing?.updatedAt === "string") {
    const candidate = buildBeacon(probe, {
      updatedAt: existing.updatedAt,
    });
    if (JSON.stringify(candidate) === JSON.stringify(existing)) {
      beacon = candidate;
    }
  }
  if (!beacon) {
    beacon = buildBeacon(probe, { updatedAt: now().toISOString() });
  }
  const text = `${JSON.stringify(beacon, null, 2)}\n`;

  if (checkOnly) {
    return { changed: false, beacon };
  }
  const primaryChanged = await writeIfChanged(output, text);
  const wellKnownChanged = await writeIfChanged(wellKnown, text);
  return {
    changed: primaryChanged || wellKnownChanged,
    beacon,
  };
}

function parseArgs(args) {
  const options = {
    urlFile: "/tmp/crow-oracle-public-url",
    output: path.join(REPO_DIR, "oracle.json"),
    wellKnown: path.join(REPO_DIR, ".well-known", "crow-oracle.json"),
    checkOnly: false,
  };
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check-only") {
      if (seen.has(arg)) fail("duplicate option");
      seen.add(arg);
      options.checkOnly = true;
      continue;
    }
    const mapping = {
      "--url-file": "urlFile",
      "--output": "output",
      "--well-known": "wellKnown",
    };
    const key = mapping[arg];
    if (!key || seen.has(arg) || !args[index + 1]) {
      fail("invalid command-line option");
    }
    seen.add(arg);
    options[key] = path.resolve(args[index + 1]);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await syncFromUrlFile(options);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      changed: result.changed,
      service: result.beacon.service,
      version: result.beacon.version,
    })}\n`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`beacon sync failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
