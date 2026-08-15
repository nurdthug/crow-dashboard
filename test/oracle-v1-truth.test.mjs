import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenKeyNames = new Set(["standardV2", "bazaar", "bazaarSupported"]);
const forbiddenText = /\b(x402[\s._-]*v2|parallel[\s._-]*x402[\s._-]*v2|standardv2|Bazaar)\b/i;

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

function findUnsupportedClaims(node, nodePath = "$", hits = []) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => findUnsupportedClaims(value, `${nodePath}[${index}]`, hits));
    return hits;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const childPath = `${nodePath}.${key}`;
      if (forbiddenKeyNames.has(key)) hits.push(`${childPath}: forbidden key ${key}`);
      if ((key === "wireVersion" || key === "x402Version") && Number(value) === 2) {
        hits.push(`${childPath}: advertises wire/x402 version 2`);
      }
      findUnsupportedClaims(value, childPath, hits);
    }
    return hits;
  }
  if (typeof node === "string" && forbiddenText.test(node)) {
    hits.push(`${nodePath}: ${JSON.stringify(node)}`);
  }
  return hits;
}

test("stable beacon remains the reviewed legacy x402 v1 direct-Solana contract", async () => {
  const beacon = await readJson("oracle.json");
  assert.equal(beacon.version, "0.3.11");
  assert.equal(beacon.payment.protocol, "x402");
  assert.equal(beacon.payment.wireVersion, 1);
  assert.equal(beacon.payment.settlement, "direct-solana");
  assert.equal(beacon.payment.compatibility, "legacy-x402-v1-direct-solana");
  assert.equal(beacon.payment.bazaarIndexed, false);
  assert.equal(beacon.payment.standardV2, undefined);
  assert.equal(findUnsupportedClaims(beacon).length, 0);
});

test("legacy buyer path stays discoverable without unsupported interop claims", async () => {
  const beacon = await readJson("oracle.json");
  for (const key of ["catalog", "freeSample", "buyerClient", "receiptVerifier", "publicState"]) {
    assert.ok(beacon.docs[key], `docs.${key} is required`);
  }
  for (const product of beacon.products) {
    assert.equal(product.quoteStatus, 402);
    assert.ok(product.price.amountBaseUnits);
    assert.equal(product.price.asset, beacon.payment.asset);
  }
  const [html, llms, buyers] = await Promise.all([
    readFile(path.join(ROOT, "index.html"), "utf8"),
    readFile(path.join(ROOT, "llms.txt"), "utf8"),
    readFile(path.join(ROOT, "BUYERS.md"), "utf8"),
  ]);
  for (const [name, content] of Object.entries({ html, llms, buyers })) {
    assert.doesNotMatch(content, /standardV2|x402[\s._-]*v2|Bazaar/i, name);
  }
});
