#!/usr/bin/env node
/**
 * Verifies that x-added-in-version annotations in the YAML spec files
 * match the version-map and that operations are in the files the endpoint-map claims.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const specDir = process.env.OCA_SPEC_PATH;
const versionMapPath = process.env.VERSION_MAP_PATH;
const endpointMapPath = process.env.ENDPOINT_MAP_PATH;

if (!specDir || !versionMapPath || !endpointMapPath) {
  console.error(
    "Missing required env variables. Set OCA_SPEC_PATH, VERSION_MAP_PATH, and ENDPOINT_MAP_PATH."
  );
  process.exit(1);
}

const versionMap = JSON.parse(readFileSync(versionMapPath, "utf-8"));
const endpointMap = JSON.parse(readFileSync(endpointMapPath, "utf-8"));

// endpoint-map.json is a plain object: { "METHOD /path": "file.yaml", ... }
const endpointToFile = new Map(Object.entries(endpointMap));

// Build a set of deleted operations to skip
const deletedOps = new Set(Object.keys(versionMap.deletedOperations || {}));

// Cache parsed YAML files
const yamlCache = new Map();
function loadYaml(file) {
  if (!yamlCache.has(file)) {
    try {
      yamlCache.set(file, parse(readFileSync(join(specDir, file), "utf-8")));
    } catch {
      yamlCache.set(file, null);
    }
  }
  return yamlCache.get(file);
}

let ok = 0;
let skippedDeleted = 0;
let errors = [];

for (const [opKey, info] of Object.entries(versionMap.operations)) {
  if (deletedOps.has(opKey)) {
    skippedDeleted++;
    continue;
  }

  const expectedVersion = info.version;
  const sourceFile = endpointToFile.get(opKey);

  if (!sourceFile) {
    errors.push({ op: opKey, issue: "NO_ENDPOINT_MAP_ENTRY" });
    continue;
  }

  const spaceIdx = opKey.indexOf(" ");
  const method = opKey.slice(0, spaceIdx).toLowerCase();
  const apiPath = opKey.slice(spaceIdx + 1);

  const doc = loadYaml(sourceFile);
  if (!doc) {
    errors.push({ op: opKey, issue: "YAML_FILE_NOT_FOUND", file: sourceFile });
    continue;
  }
  if (!doc.paths || !doc.paths[apiPath]) {
    errors.push({ op: opKey, issue: "PATH_NOT_IN_YAML", file: sourceFile, path: apiPath });
    continue;
  }
  if (!doc.paths[apiPath][method]) {
    errors.push({ op: opKey, issue: "METHOD_NOT_IN_YAML", file: sourceFile, path: apiPath, method });
    continue;
  }

  const operation = doc.paths[apiPath][method];
  const actual = operation["x-added-in-version"];
  if (!actual) {
    errors.push({ op: opKey, issue: "MISSING_X_ADDED_IN_VERSION", file: sourceFile, expected: expectedVersion });
  } else if (String(actual) !== String(expectedVersion)) {
    errors.push({ op: opKey, issue: "VERSION_MISMATCH", file: sourceFile, expected: expectedVersion, actual: String(actual) });
  } else {
    ok++;
  }
}

// Check for operations in YAML files that are NOT in version-map
const versionMapOps = new Set(Object.keys(versionMap.operations));
const allYamlFiles = [...new Set(Object.values(endpointMap))];
let extraOps = [];

for (const file of allYamlFiles) {
  const doc = loadYaml(file);
  if (!doc || !doc.paths) continue;
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (!methods[method]) continue;
      const opKey = method.toUpperCase() + " " + path;
      if (!versionMapOps.has(opKey)) {
        const has = methods[method]["x-added-in-version"];
        extraOps.push({ op: opKey, file, hasAnnotation: !!has, annotationValue: has || null });
      }
    }
  }
}

console.log("=== Verification Results ===\n");
console.log("Operations in version-map: " + Object.keys(versionMap.operations).length);
console.log("  OK: " + ok);
console.log("  Deleted (skipped): " + skippedDeleted);
console.log("  Errors: " + errors.length);

if (errors.length) {
  console.log("\n--- ERRORS ---");
  for (const e of errors) {
    console.log("  " + e.issue + ": " + e.op + (e.file ? " (" + e.file + ")" : "") +
      (e.expected ? " expected=" + e.expected : "") +
      (e.actual ? " actual=" + e.actual : ""));
  }
}

if (extraOps.length) {
  console.log("\n--- Operations in YAML but NOT in version-map (" + extraOps.length + ") ---");
  for (const e of extraOps) {
    console.log("  " + e.op + " (" + e.file + ")" +
      (e.hasAnnotation ? " [has x-added-in-version=" + e.annotationValue + "]" : " [NO x-added-in-version]"));
  }
}

if (!errors.length && !extraOps.length) {
  console.log("\nAll checks passed!");
}
