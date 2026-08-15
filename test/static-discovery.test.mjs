import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function text(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("stable discovery files agree byte-for-byte", async () => {
  const primary = await text("oracle.json");
  const wellKnown = await text(".well-known/crow-oracle.json");
  assert.equal(primary, wellKnown);

  const beacon = JSON.parse(primary);
  assert.equal(
    beacon.stableBeacon,
    "https://nurdthug.github.io/crow-dashboard/oracle.json",
  );
  assert.equal(beacon.backend.permanent, false);
  assert.equal(beacon.version, "0.3.11");
  assert.equal(
    beacon.payment.compatibility,
    "legacy-x402-v1-direct-solana",
  );
  assert.equal(beacon.payment.wireVersion, 1);
  assert.equal(beacon.payment.bazaarIndexed, false);
  assert.equal(beacon.payment.settlement, "direct-solana");
  assert.equal(beacon.payment.receipt.serverSigned, false);
  assert.equal(beacon.payment.receipt.onChainChecked, false);
  assert.equal(beacon.payment.standardV2, undefined);
});

test("dashboard and agent context point to stable discovery", async () => {
  const [html, llms, robots, sitemap] = await Promise.all([
    text("index.html"),
    text("llms.txt"),
    text("robots.txt"),
    text("sitemap.xml"),
  ]);
  for (const content of [html, llms, sitemap]) {
    assert.match(
      content,
      /https:\/\/nurdthug\.github\.io\/crow-dashboard\/oracle\.json/,
    );
  }
  assert.match(robots, /Sitemap: https:\/\/nurdthug\.github\.io/);
  assert.match(html, /rel="alternate" type="application\/json"/);
  assert.match(llms, /legacy x402 v1/);
  assert.doesNotMatch(llms, /x402 v2/i);
  assert.doesNotMatch(llms, /Bazaar/i);
  assert.doesNotMatch(html, /standardV2/);
});

test("new discovery sources contain no local paths or credential shapes", async () => {
  const sources = await Promise.all([
    text("scripts/update-oracle-beacon.mjs"),
    text("scripts/sync-oracle-beacon.sh"),
    text("launchd/com.crownetwork.oracle-beacon-sync.plist.template"),
    text("oracle.json"),
    text("llms.txt"),
  ]);
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /\/Users\/rowlow\//);
  assert.doesNotMatch(combined, /gho_[A-Za-z0-9]+/);
  assert.doesNotMatch(combined, /github_pat_[A-Za-z0-9_]+/);
  assert.doesNotMatch(combined, /AKIA[0-9A-Z]{16}/);
});
