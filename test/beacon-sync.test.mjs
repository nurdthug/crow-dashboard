import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIT = "/usr/bin/git";
const ZSH = "/bin/zsh";

async function run(command, args, options = {}) {
  return execFile(command, args, {
    maxBuffer: 1_000_000,
    ...options,
  });
}

async function git(cwd, ...args) {
  return run(GIT, args, { cwd });
}

test(
  "sync recovers an authenticated push race on the next autonomous run",
  { timeout: 20_000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "crow-sync-"));
    const remote = path.join(temp, "remote.git");
    const repo = path.join(temp, "repo");
    const racer = path.join(temp, "racer");
    const verifier = path.join(temp, "verifier");
    const fakeNode = path.join(temp, "fake-node.mjs");
    const home = path.join(temp, "home");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      HOME: home,
      NODE_BIN: fakeNode,
      RACER_DIR: racer,
    };

    try {
      await mkdir(home);
      await run(GIT, ["init", "--bare", remote]);
      await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
      await mkdir(repo);
      await git(repo, "init");
      await git(repo, "checkout", "-b", "main");
      await git(repo, "config", "user.name", "test");
      await git(repo, "config", "user.email", "test@example.com");
      await mkdir(path.join(repo, "scripts"));
      await mkdir(path.join(repo, ".well-known"));
      await copyFile(
        path.join(ROOT, "scripts", "sync-oracle-beacon.sh"),
        path.join(repo, "scripts", "sync-oracle-beacon.sh"),
      );
      await writeFile(
        path.join(repo, "scripts", "update-oracle-beacon.mjs"),
        "// Replaced by the test's NODE_BIN fixture.\n",
      );
      await writeFile(path.join(repo, "oracle.json"), '{"state":"old"}\n');
      await writeFile(
        path.join(repo, ".well-known", "crow-oracle.json"),
        '{"state":"old"}\n',
      );
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "Initial");
      await git(repo, "remote", "add", "origin", remote);
      await git(repo, "push", "-u", "origin", "main");

      await run(GIT, ["clone", remote, racer]);
      await git(racer, "config", "user.name", "racer");
      await git(racer, "config", "user.email", "racer@example.com");

      await writeFile(
        fakeNode,
        `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

mkdirSync(".well-known", { recursive: true });
writeFileSync("oracle.json", '{"state":"new"}\\n');
writeFileSync(".well-known/crow-oracle.json", '{"state":"new"}\\n');
const marker = path.join(process.cwd(), ".race-done");
if (!existsSync(marker)) {
  writeFileSync(marker, "done\\n");
  writeFileSync(path.join(process.env.RACER_DIR, "race.txt"), "remote update\\n");
  execFileSync("/usr/bin/git", ["add", "race.txt"], { cwd: process.env.RACER_DIR });
  execFileSync("/usr/bin/git", ["commit", "-m", "Concurrent remote update"], { cwd: process.env.RACER_DIR });
  execFileSync("/usr/bin/git", ["push", "origin", "main"], { cwd: process.env.RACER_DIR });
}
process.stdout.write('{"ok":true,"changed":true}\\n');
`,
      );
      await chmod(fakeNode, 0o755);

      await assert.rejects(
        run(
          ZSH,
          [path.join(repo, "scripts", "sync-oracle-beacon.sh")],
          { cwd: repo, env },
        ),
      );

      await run(
        ZSH,
        [path.join(repo, "scripts", "sync-oracle-beacon.sh")],
        { cwd: repo, env },
      );

      await run(GIT, ["clone", remote, verifier]);
      assert.equal(
        await readFile(path.join(verifier, "oracle.json"), "utf8"),
        '{"state":"new"}\n',
      );
      assert.equal(
        await readFile(path.join(verifier, "race.txt"), "utf8"),
        "remote update\n",
      );
      const { stdout: subjects } = await git(
        verifier,
        "log",
        "--format=%s",
      );
      assert.match(subjects, /Update Crow Oracle discovery beacon/);
      assert.match(subjects, /Concurrent remote update/);
      const { stdout: localHead } = await git(repo, "rev-parse", "HEAD");
      const { stdout: remoteHead } = await git(
        repo,
        "rev-parse",
        "origin/main",
      );
      assert.equal(localHead, remoteHead);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
