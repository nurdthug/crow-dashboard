#!/usr/bin/env node

import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");

export const EXPECTED = Object.freeze({
  version: "0.3.11",
  service: "crow-oracle",
  operator: "RowLow",
  healthNetwork: "mainnet",
  catalogNetwork: "solana-mainnet",
  payTo: "AxaEvPSnYhDALmxordg2zzqZxEoALrQpt17ZL8CsGsNh",
  tokenAccount: "4W7xRpvGz1mqtVANNrRWHR3KAVMcc1LQrooym2weTbh5",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  tokenRiskAmount: "30000",
  lendingHealthAmount: "50000",
  stableOrigin: "https://nurdthug.github.io/crow-dashboard",
});

const MAX_JSON_BYTES = 1_000_000;
const QUOTE_RESOURCES = Object.freeze({
  tokenRisk: "/check/11111111111111111111111111111111",
  lendingHealth: "/health/11111111111111111111111111111111",
});

function fail(message) {
  throw new Error(message);
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
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned malformed JSON`);
  }
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
  const [health, catalog, sample, tokenRiskQuote, lendingHealthQuote] =
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
  return {
    baseUrl,
    health,
    catalog,
    sample,
    quotes: {
      tokenRisk: tokenRiskQuote,
      lendingHealth: lendingHealthQuote,
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
  const accepted = quotes.tokenRisk.accepts[0];
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
      compatibility: "legacy-x402-v1",
      bazaarIndexed: false,
      payTo: accepted.payTo,
      tokenAccount: accepted.tokenAccount,
      asset: accepted.asset,
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
  const updatedAt =
    existing?.backend?.baseUrl === probe.baseUrl &&
    typeof existing?.updatedAt === "string"
      ? existing.updatedAt
      : now().toISOString();
  const beacon = buildBeacon(probe, { updatedAt });
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
