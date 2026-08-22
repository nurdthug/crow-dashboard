#!/usr/bin/env node

export {
  EXPECTED,
  buildBeacon,
  parseTemporaryBackend,
  probeOracle,
  syncFromUrlFile,
  writeIfChanged,
} from "./sync-oracle-v1-beacon.mjs";

import { main } from "./sync-oracle-v1-beacon.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`beacon sync failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
