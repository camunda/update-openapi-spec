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
import { parseDocument } from "yaml";

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
// endpoint-map.json is a plain object: { "METHOD /path": "file.yaml", ... }
const endpointToFile = new Map(Object.entries(endpointMap));

// Build a set of deleted operations to skip
const deletedOps = new Set(Object.keys(versionMap.deletedOperations || {}));

// ── Group operations by source file ──────────────────────────────────────────

// Map<sourceFile, Array<{ method, path, version }>>
const fileOps = new Map();
let skippedDeleted = 0;

for (const [operationKey, info] of Object.entries(versionMap.operations)) {
  if (deletedOps.has(operationKey)) {
    skippedDeleted++;
    continue;
  }

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

// ── Update YAML files via text insertion (preserves all formatting) ───────────

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

  // Parse to discover operation node ranges
  const doc = parseDocument(content);
  const pathsNode = doc.get("paths", true);
  if (!pathsNode) {
    console.warn(`  ⚠  No paths in ${sourceFile}, skipping`);
    continue;
  }

  // Collect insertions: { offset, line } sorted descending so later inserts don't shift earlier offsets
  const insertions = [];

  for (const { method, apiPath, version } of ops) {
    const pathNode = pathsNode.get(apiPath, true);
    if (!pathNode) {
      console.warn(
        `  ⚠  ${method.toUpperCase()} ${apiPath} not found in ${sourceFile}, skipping`
      );
      skippedOps++;
      continue;
    }
    const opNode = pathNode.get(method, true);
    if (!opNode) {
      console.warn(
        `  ⚠  ${method.toUpperCase()} ${apiPath} not found in ${sourceFile}, skipping`
      );
      skippedOps++;
      continue;
    }

    // Skip if already annotated
    if (opNode.get("x-added-in-version") != null) {
      updatedOps++;
      continue;
    }

    // range = [startOffset, valueEndOffset, nodeEndOffset]
    const range = opNode.range;
    if (!range) {
      console.warn(
        `  ⚠  No range for ${method.toUpperCase()} ${apiPath} in ${sourceFile}, skipping`
      );
      skippedOps++;
      continue;
    }

    // Determine indentation: find the line where the operation key starts in the parent map
    // The operation's own keys (summary, operationId, etc.) are indented at a consistent level.
    // We find the first key's indentation by looking at the start of the opNode.
    const nodeStart = range[0];
    // Walk backwards from nodeStart to find the beginning of the line
    let lineStart = content.lastIndexOf("\n", nodeStart - 1) + 1;
    const indent = " ".repeat(nodeStart - lineStart);

    // Find the insertion point: end of the operation node content (before trailing whitespace)
    const nodeEnd = range[2];
    // Find the last non-whitespace character before nodeEnd
    let insertAt = nodeEnd;
    while (insertAt > range[0] && (content[insertAt - 1] === "\n" || content[insertAt - 1] === " ")) {
      insertAt--;
    }
    // Move to the end of that line
    const eol = content.indexOf("\n", insertAt);
    insertAt = eol === -1 ? content.length : eol + 1;

    const line = `${indent}x-added-in-version: "${version}"\n`;
    insertions.push({ offset: insertAt, line });
    updatedOps++;
  }

  if (insertions.length === 0) continue;

  // Sort by offset descending so insertions don't shift each other
  insertions.sort((a, b) => b.offset - a.offset);

  let result = content;
  for (const { offset, line } of insertions) {
    result = result.slice(0, offset) + line + result.slice(offset);
  }

  writeFileSync(filePath, result, "utf-8");
  updatedFiles++;
  console.log(`  ✓  ${sourceFile} (${ops.length} operations)`);
}

console.log(
  `\nDone – updated ${updatedOps} operations across ${updatedFiles} files` +
    (skippedDeleted ? `, ${skippedDeleted} deleted ops skipped` : "") +
    (skippedOps ? `, ${skippedOps} not found in YAML` : "")
);
