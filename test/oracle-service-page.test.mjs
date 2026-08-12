import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function text(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

function makePageHarness() {
  const links = Object.fromEntries(
    ["sample", "catalog", "client", "verifier"].map((name) => [
      name,
      {
        href: "../oracle.json",
        attributes: new Map([["aria-disabled", "true"]]),
        setAttribute(key, value) { this.attributes.set(key, value); },
        getAttribute(key) { return this.attributes.get(key); },
      },
    ]),
  );
  const dot = { className: "dot" };
  const healthCopy = { textContent: "Checking the public backend" };
  return {
    links,
    dot,
    healthCopy,
    document: {
      querySelector(selector) {
        return links[selector.match(/data-live="([^"]+)"/)?.[1]];
      },
      getElementById(id) {
        return id === "health-dot" ? dot : healthCopy;
      },
    },
  };
}

async function runServiceScript(fetchImpl) {
  const html = await text("oracle/index.html");
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  const harness = makePageHarness();
  vm.runInNewContext(scripts.at(-1)[1], {
    document: harness.document,
    fetch: fetchImpl,
    URL,
  });
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return harness;
}

function validBeacon(overrides = {}) {
  const backend = "https://unit-test.trycloudflare.com";
  return {
    service: "crow-oracle",
    payment: { protocol: "x402", wireVersion: 1 },
    backend: {
      baseUrl: backend,
      permanent: false,
      health: `${backend}/healthz`,
    },
    docs: {
      freeSample: `${backend}/sample/token-risk`,
      catalog: `${backend}/catalog.json`,
      buyerClient: `${backend}/buyer-client.mjs`,
      receiptVerifier: `${backend}/verify-receipt.mjs`,
    },
    products: [
      { id: "token-risk-check", price: { amountBaseUnits: "30000" } },
      { id: "lending-health", price: { amountBaseUnits: "50000" } },
    ],
    ...overrides,
  };
}

test("service page exposes crawlable Crow Oracle metadata and exact offers", async () => {
  const html = await text("oracle/index.html");
  assert.match(html, /<title>Crow Oracle \| Solana token risk and lending health API<\/title>/);
  assert.match(html, /<meta name="robots" content="index,follow">/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/nurdthug\.github\.io\/crow-dashboard\/oracle\/">/,
  );

  const match = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, "JSON-LD service metadata must exist");
  const schema = JSON.parse(match[1]);
  assert.equal(schema["@type"], "Service");
  assert.equal(schema.name, "Crow Oracle");
  assert.equal(schema.url, "https://nurdthug.github.io/crow-dashboard/oracle/");
  assert.deepEqual(
    schema.offers.map(({ name, price, priceCurrency }) => ({ name, price, priceCurrency })),
    [
      { name: "Solana token risk verdict", price: "0.03", priceCurrency: "USDC" },
      { name: "Solana lending health check", price: "0.05", priceCurrency: "USDC" },
    ],
  );
});

test("service page is honest about the legacy direct-settlement path", async () => {
  const html = await text("oracle/index.html");
  assert.match(html, /legacy x402 v1 direct Solana USDC settlement/i);
  assert.match(html, /Only independently verified settlement signatures count as revenue/);
  assert.doesNotMatch(html, /x402 v2/i);
  assert.doesNotMatch(html, /Bazaar/i);
});

test("service page keeps live actions closed until same-origin health passes", async () => {
  const html = await text("oracle/index.html");
  assert.match(html, /const BEACON_URL = "https:\/\/nurdthug\.github\.io\/crow-dashboard\/oracle\.json"/);
  assert.equal((html.match(/<a[^>]+data-live=/g) || []).length, 4);
  assert.equal((html.match(/href="\.\.\/oracle\.json" aria-disabled="true"/g) || []).length, 4);
  assert.match(html, /url\.protocol === "https:" && !url\.username && !url\.password && url\.origin === backend\.origin/);
  assert.match(html, /beacon\.payment\?\.wireVersion !== 1/);
  assert.match(html, /beacon\.backend\?\.permanent !== false/);
  assert.match(html, /\["token-risk-check", "30000"\]/);
  assert.match(html, /\["lending-health", "50000"\]/);
  assert.match(html, /mode: "no-cors"/);
  assert.match(html, /redirect: "error"/);
  assert.match(html, /healthResponse\.type !== "opaque" && !healthResponse\.ok/);
  assert.match(html, /verify the live unpaid quote before payment/);
  assert.match(html, /failClosed\("Public backend unavailable; use the stable beacon before payment"\)/);
});

test("service page activates only same-origin resources after backend reachability", async () => {
  const beacon = validBeacon();
  const calls = [];
  const harness = await runServiceScript(async (url, options) => {
    calls.push({ url, options });
    if (url === "https://nurdthug.github.io/crow-dashboard/oracle.json") {
      return { ok: true, json: async () => beacon };
    }
    assert.equal(url, beacon.backend.health);
    return { ok: false, type: "opaque" };
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.cache, "no-store");
  assert.equal(calls[1].options.mode, "no-cors");
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(harness.dot.className, "dot live");
  assert.match(harness.healthCopy.textContent, /verify the live unpaid quote before payment/);
  for (const [name, link] of Object.entries(harness.links)) {
    const expected = {
      sample: beacon.docs.freeSample,
      catalog: beacon.docs.catalog,
      client: beacon.docs.buyerClient,
      verifier: beacon.docs.receiptVerifier,
    }[name];
    assert.equal(link.href, expected);
    assert.equal(link.getAttribute("aria-disabled"), "false");
  }
});

test("service page fails closed before reachability on a rebound live resource", async () => {
  const beacon = validBeacon({
    docs: {
      ...validBeacon().docs,
      receiptVerifier: "https://attacker.example/verify-receipt.mjs",
    },
  });
  let calls = 0;
  const harness = await runServiceScript(async () => {
    calls += 1;
    return { ok: true, json: async () => beacon };
  });

  assert.equal(calls, 1);
  assert.equal(harness.dot.className, "dot failed");
  assert.equal(
    harness.healthCopy.textContent,
    "Public backend unavailable; use the stable beacon before payment",
  );
  for (const link of Object.values(harness.links)) {
    assert.equal(link.href, "../oracle.json");
    assert.equal(link.getAttribute("aria-disabled"), "true");
  }
});

test("dashboard and sitemap expose the service page", async () => {
  const [dashboard, sitemap] = await Promise.all([
    text("index.html"),
    text("sitemap.xml"),
  ]);
  assert.match(dashboard, /<a href="oracle\/" id="oracle-service">Service page<\/a>/);
  assert.match(
    sitemap,
    /<loc>https:\/\/nurdthug\.github\.io\/crow-dashboard\/oracle\/<\/loc>/,
  );
});

test("service discovery additions contain no local paths or credential shapes", async () => {
  const sources = await Promise.all([
    text("oracle/index.html"),
    text("index.html"),
    text("sitemap.xml"),
  ]);
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /\/Users\/rowlow\//);
  assert.doesNotMatch(combined, /gho_[A-Za-z0-9]+/);
  assert.doesNotMatch(combined, /github_pat_[A-Za-z0-9_]+/);
  assert.doesNotMatch(combined, /AKIA[0-9A-Z]{16}/);
});
