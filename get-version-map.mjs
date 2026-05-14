#!/usr/bin/env node
/**
 * Generates version-map.json by cloning the
 * return-of-api-added-in-analysis repo at a configurable git ref into a
 * temporary directory, running `npm install && npm run all` inside it, and
 * copying the produced `output/version-map.json` to the configured path.
 *
 * The git-clone strategy mirrors the depth-1 / SHA-aware logic from
 * camunda-schema-bundler/src/fetch.ts so this script understands branches,
 * tags, and raw commit SHAs uniformly.
 *
 * Env:
 *   RETURN_OF_API_REF         Git ref to clone (default: "main")
 *   RETURN_OF_API_REPO_URL    Git repo URL
 *                             (default: https://github.com/camunda/return-of-api-added-in-analysis.git)
 *   VERSION_MAP_PATH          Output path (default: ./version-map.json)
 *
 * Usage:
 *   node get-version-map.mjs
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ref = process.env.RETURN_OF_API_REF ?? "main";
const repoUrl =
  process.env.RETURN_OF_API_REPO_URL ??
  "https://github.com/camunda/return-of-api-added-in-analysis.git";
const versionMapPath = resolve(process.env.VERSION_MAP_PATH ?? "./version-map.json");

if (existsSync(versionMapPath)) {
  console.log(`Skipping — ${versionMapPath} already exists. Delete it to regenerate.`);
  process.exit(0);
}

/** A ref that's 7-40 hex characters is treated as a commit SHA. */
function isCommitSha(r) {
  return /^[0-9a-f]{7,40}$/i.test(r);
}

function run(args, options = {}) {
  execFileSync(args[0], args.slice(1), {
    stdio: "inherit",
    timeout: 600_000,
    ...options,
  });
}

const tmpRoot = mkdtempSync(join(tmpdir(), "return-of-api-added-"));
const cloneDir = join(tmpRoot, "repo");

try {
  console.log(`Cloning ${repoUrl} @ ${ref}…`);
  if (isCommitSha(ref)) {
    // Branch/tag refs work with `git clone --branch`; raw commit SHAs do not.
    // Fall back to init + fetch-by-SHA, which GitHub permits because the repo
    // sets uploadpack.allowReachableSHA1InWant on the server side.
    run(["git", "init", cloneDir]);
    run(["git", "-C", cloneDir, "remote", "add", "origin", repoUrl]);
    run(["git", "-C", cloneDir, "fetch", "--depth", "1", "origin", ref]);
    run(["git", "-C", cloneDir, "checkout", "FETCH_HEAD"]);
  } else {
    run(["git", "clone", "--depth", "1", "--branch", ref, repoUrl, cloneDir]);
  }

  console.log("Installing dependencies…");
  run(["npm", "install"], { cwd: cloneDir });

  console.log("Running `npm run all`…");
  run(["npm", "run", "all"], { cwd: cloneDir });

  const producedPath = join(cloneDir, "output", "version-map.json");
  if (!existsSync(producedPath)) {
    throw new Error(
      `Expected version map at ${producedPath} after \`npm run all\` — not found.`,
    );
  }
  copyFileSync(producedPath, versionMapPath);
  console.log(`Wrote ${versionMapPath}`);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
