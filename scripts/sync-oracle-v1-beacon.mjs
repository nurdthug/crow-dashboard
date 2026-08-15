#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");

const EXPECTED = Object.freeze({
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

const QUOTES = Object.freeze({
  tokenRisk: ["/check/11111111111111111111111111111111", EXPECTED.tokenRiskAmount],
  lendingHealth: ["/health/11111111111111111111111111111111", EXPECTED.lendingHealthAmount],
});

function fail(message) {
  throw new Error(message);
}

function equal(actual, expected, label) {
  if (actual !== expected) fail(`${label} mismatch`);
}

function parseArgs(args) {
  const options = {
    urlFile: "/tmp/crow-oracle-public-url",
    output: path.join(REPO_DIR, "oracle.json"),
    wellKnown: path.join(REPO_DIR, ".well-known", "crow-oracle.json"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = { "--url-file": "urlFile", "--output": "output", "--well-known": "wellKnown" }[args[index]];
    if (!key || !args[index + 1]) fail("invalid command-line option");
    options[key] = path.resolve(args[index + 1]);
    index += 1;
  }
  return options;
}

async function fetchJson(url, label, expectedStatus = 200) {
  const response = await fetch(url, { redirect: "manual" });
  if (response.status !== expectedStatus) fail(`${label} returned ${response.status}`);
  const type = response.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) fail(`${label} is not JSON`);
  return response.json();
}

function validateQuote(quote, resource, amount, label) {
  equal(quote?.x402Version, 1, `${label} quote x402Version`);
  const accepts = quote?.accepts;
  if (!Array.isArray(accepts) || accepts.length !== 1) fail(`${label} quote accepts shape`);
  const accept = accepts[0];
  equal(accept.scheme, "exact", `${label} scheme`);
  equal(accept.network, EXPECTED.catalogNetwork, `${label} network`);
  equal(accept.resource, resource, `${label} resource`);
  equal(accept.payTo, EXPECTED.payTo, `${label} payTo`);
  equal(accept.tokenAccount, EXPECTED.tokenAccount, `${label} token account`);
  equal(accept.asset, EXPECTED.asset, `${label} asset`);
  equal(accept.maxAmountRequired, amount, `${label} amount`);
  return accept;
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

async function writeIfChanged(filePath, text) {
  try {
    if ((await readFile(filePath, "utf8")) === text) return false;
  } catch {
    // Recreated below.
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, text, { encoding: "utf8", mode: 0o644 });
  await rename(tempPath, filePath);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = (await readFile(options.urlFile, "utf8")).trim().replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".trycloudflare.com")) {
    fail("backend URL is not an account-less Cloudflare HTTPS hostname");
  }

  const [health, catalog, sample, tokenRiskQuote, lendingHealthQuote] = await Promise.all([
    fetchJson(`${baseUrl}/healthz`, "health"),
    fetchJson(`${baseUrl}/catalog.json`, "catalog"),
    fetchJson(`${baseUrl}/sample/token-risk`, "sample"),
    fetchJson(`${baseUrl}${QUOTES.tokenRisk[0]}`, "token-risk quote", 402),
    fetchJson(`${baseUrl}${QUOTES.lendingHealth[0]}`, "lending-health quote", 402),
  ]);

  equal(health?.ok, true, "health ok");
  equal(health?.service, EXPECTED.service, "health service");
  equal(health?.version, EXPECTED.version, "health version");
  equal(health?.network, EXPECTED.healthNetwork, "health network");
  equal(catalog?.service, EXPECTED.service, "catalog service");
  equal(catalog?.version, EXPECTED.version, "catalog version");
  equal(catalog?.payment?.wireVersion, 1, "catalog payment wire version");
  equal(catalog?.payment?.settlement, "direct-solana", "catalog settlement");
  equal(catalog?.payment?.bazaarIndexed, false, "catalog external indexing");
  if ("standardV2" in (catalog.payment || {})) fail("catalog includes unsupported standardV2");
  equal(sample?.service, EXPECTED.service, "sample service");
  equal(sample?.billable, false, "sample billable");

  const accepted = validateQuote(tokenRiskQuote, QUOTES.tokenRisk[0], QUOTES.tokenRisk[1], "token-risk");
  validateQuote(lendingHealthQuote, QUOTES.lendingHealth[0], QUOTES.lendingHealth[1], "lending-health");

  const existing = JSON.parse(await readFile(options.output, "utf8"));
  const beacon = {
    schemaVersion: 1,
    service: EXPECTED.service,
    operator: EXPECTED.operator,
    version: EXPECTED.version,
    stableOrigin: EXPECTED.stableOrigin,
    stableBeacon: `${EXPECTED.stableOrigin}/oracle.json`,
    updatedAt: existing.updatedAt || new Date().toISOString(),
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
    revenueAccounting: "Only unique confirmed x402 settlement signatures count as Crow revenue.",
    payment: {
      protocol: "x402",
      wireVersion: 1,
      scheme: "exact",
      settlement: "direct-solana",
      compatibility: "legacy-x402-v1-direct-solana",
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
      publication: "Authenticated GitHub repository update after live health, catalog, sample, and unpaid-quote validation.",
      redirectPolicy: "reject",
      credentialBearingBackendUrls: "reject",
    },
  };
  const text = `${JSON.stringify(beacon, null, 2)}\n`;
  const changed = (await writeIfChanged(options.output, text)) || (await writeIfChanged(options.wellKnown, text));
  process.stdout.write(`${JSON.stringify({ ok: true, changed, service: beacon.service, version: beacon.version })}\n`);
}

main().catch((error) => {
  process.stderr.write(`v1 beacon sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
