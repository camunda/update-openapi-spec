#!/usr/bin/env node
/**
 * Adds `x-added-in-version` to operations in OpenAPI YAML spec files.
 *
 * Env variables:
 *   OCA_SPEC_PATH     – directory containing the upstream YAML spec files
 *   VERSION_MAP_PATH  – path to version-map.json
 *   ENDPOINT_MAP_PATH – path to endpoint-map.json
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const specDir = process.env.OCA_SPEC_PATH;
const versionMapPath = process.env.VERSION_MAP_PATH;
const endpointMapPath = process.env.ENDPOINT_MAP_PATH;

if (!specDir || !versionMapPath || !endpointMapPath) {
  console.error(
    "Missing required env variables. Set OCA_SPEC_PATH, VERSION_MAP_PATH, and ENDPOINT_MAP_PATH."
  );
  process.exit(1);
}

// ── Load inputs ──────────────────────────────────────────────────────────────

const versionMap = JSON.parse(readFileSync(versionMapPath, "utf-8"));
const endpointMap = JSON.parse(readFileSync(endpointMapPath, "utf-8"));

// Build a lookup: "METHOD /path" → sourceFile
const endpointToFile = new Map(
  endpointMap.map((e) => [e.operation, e.sourceFile])
);

// ── Group operations by source file ──────────────────────────────────────────

// Map<sourceFile, Array<{ method, path, version }>>
const fileOps = new Map();

for (const [operationKey, info] of Object.entries(versionMap.operations)) {
  const sourceFile = endpointToFile.get(operationKey);
  if (!sourceFile) {
    console.warn(`  ⚠  No endpoint-map entry for "${operationKey}", skipping`);
    continue;
  }

  // operationKey looks like "GET /topology" or "POST /jobs/{jobKey}/failure"
  const spaceIdx = operationKey.indexOf(" ");
  const method = operationKey.slice(0, spaceIdx).toLowerCase();
  const apiPath = operationKey.slice(spaceIdx + 1);

  if (!fileOps.has(sourceFile)) {
    fileOps.set(sourceFile, []);
  }
  fileOps.get(sourceFile).push({ method, apiPath, version: info.version });
}

// ── Update YAML files ────────────────────────────────────────────────────────

let updatedFiles = 0;
let updatedOps = 0;
let skippedOps = 0;

for (const [sourceFile, ops] of fileOps) {
  const filePath = join(specDir, sourceFile);

  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    console.warn(`  ⚠  Could not read ${filePath}, skipping`);
    continue;
  }

  const doc = yaml.load(content);
  if (!doc || !doc.paths) {
    console.warn(`  ⚠  No paths in ${sourceFile}, skipping`);
    continue;
  }

  let fileChanged = false;

  for (const { method, apiPath, version } of ops) {
    const pathObj = doc.paths[apiPath];
    if (!pathObj || !pathObj[method]) {
      console.warn(
        `  ⚠  ${method.toUpperCase()} ${apiPath} not found in ${sourceFile}, skipping`
      );
      skippedOps++;
      continue;
    }

    pathObj[method]["x-added-in-version"] = version;
    fileChanged = true;
    updatedOps++;
  }

  if (fileChanged) {
    const output = yaml.dump(doc, {
      lineWidth: -1,
      noRefs: true,
      quotingType: "'",
      forceQuotes: false,
    });
    writeFileSync(filePath, output, "utf-8");
    updatedFiles++;
    console.log(`  ✓  ${sourceFile} (${ops.length} operations)`);
  }
}

console.log(
  `\nDone – updated ${updatedOps} operations across ${updatedFiles} files` +
    (skippedOps ? ` (${skippedOps} skipped)` : "")
);
