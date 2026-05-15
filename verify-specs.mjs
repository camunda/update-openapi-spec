#!/usr/bin/env node
/**
 * Verifies that x-added-in-version annotations in the YAML spec files
 * match the version-map and that operations are in the files the
 * endpoint-map claims. Also verifies schema-property annotations against
 * the same rules used by update-specs-properties.mjs:
 *   - planned annotations must be present with the expected version,
 *   - suppressed properties (Rule 1 / Rule 2) must NOT carry an annotation
 *     that disagrees with their aggregated intro.
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

// ── Property verification ───────────────────────────────────────────────────

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function resolveFileAndPath(propPath, endpointPath) {
  if (!propPath || propPath.length === 0) return null;
  if (typeof propPath[0] === "string" && propPath[0].endsWith(".yaml")) {
    return { file: propPath[0], inFilePath: propPath.slice(1) };
  }
  if (typeof endpointPath?.[0] === "string" && endpointPath[0].endsWith(".yaml")) {
    return { file: endpointPath[0], inFilePath: propPath };
  }
  return null;
}

function locationKey(file, inFilePath) {
  return `${file}\x00${inFilePath.join("\x00")}`;
}

function getAt(obj, path) {
  let node = obj;
  for (const seg of path) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[seg];
  }
  return node;
}

const parentOf = new Map();
for (const [propKey, entry] of Object.entries(versionMap.properties || {})) {
  for (const childKey of entry.children || []) parentOf.set(childKey, propKey);
}

function locationKeyOfPropEntry(entry) {
  if (!entry) return null;
  const epInfo = versionMap.operations?.[entry.endpoint];
  const r = resolveFileAndPath(entry.path, epInfo?.path);
  return r ? locationKey(r.file, r.inFilePath) : null;
}

// Phase 1: aggregate by upstream location.
const locations = new Map();
for (const [propKey, entry] of Object.entries(versionMap.properties || {})) {
  if (versionMap.deletedProperties?.[propKey]) continue;
  const epInfo = versionMap.operations?.[entry.endpoint];
  const resolved = resolveFileAndPath(entry.path, epInfo?.path);
  if (!resolved) continue;
  const key = locationKey(resolved.file, resolved.inFilePath);
  let loc = locations.get(key);
  if (!loc) {
    loc = {
      file: resolved.file,
      inFilePath: resolved.inFilePath,
      intro: entry.version,
      endpointVersions: new Set(),
      consumerEndpoints: new Set(),
      propKeys: [],
    };
    locations.set(key, loc);
  } else if (compareVersions(entry.version, loc.intro) < 0) {
    loc.intro = entry.version;
  }
  loc.propKeys.push(propKey);
  loc.endpointVersions.add(epInfo?.version ?? null);
  if (entry.endpoint) loc.consumerEndpoints.add(entry.endpoint);
}

// Phase 2: classify each location as expected-annotated or expected-suppressed.
const expected = new Map();
for (const [key, loc] of locations) {
  const allEndpointsMatchIntro =
    loc.endpointVersions.size > 0
    && [...loc.endpointVersions].every((v) => v === loc.intro);
  if (allEndpointsMatchIntro) {
    // Rule 1: single consumer endpoint matches its endpoint's intro.
    // Rule 3: shared schema (multiple consumer endpoints) where every
    // consumer endpoint matches the aggregated (earliest) intro.
    const reason = loc.consumerEndpoints.size <= 1 ? "rule1" : "rule3";
    expected.set(key, { ...loc, expectAnnotated: false, reason });
    continue;
  }
  const parentLocKeys = new Set();
  let everyPropHasParent = loc.propKeys.length > 0;
  for (const pk of loc.propKeys) {
    const parentKey = parentOf.get(pk);
    if (!parentKey) { everyPropHasParent = false; break; }
    const parentLocKey = locationKeyOfPropEntry(versionMap.properties[parentKey]);
    if (!parentLocKey) { everyPropHasParent = false; break; }
    parentLocKeys.add(parentLocKey);
  }
  if (everyPropHasParent && parentLocKeys.size > 0) {
    const allParentsMatch = [...parentLocKeys].every((pk) => {
      const pl = locations.get(pk);
      return pl && pl.intro === loc.intro;
    });
    if (allParentsMatch) {
      expected.set(key, { ...loc, expectAnnotated: false, reason: "rule2" });
      continue;
    }
  }
  expected.set(key, { ...loc, expectAnnotated: true, reason: "annotate" });
}

// Phase 3: check actual annotations in the upstream YAML.
//
// Annotations live on the PARENT schema as a sequence of
// `{ propertyName, addedInVersion }` objects (the format produced by
// update-specs-properties.mjs). For each location we resolve the parent
// mapping and look up the version by property name.
function lookupParentLevelAnnotation(doc, inFilePath) {
  if (inFilePath.length < 2 || inFilePath[inFilePath.length - 2] !== "properties") {
    return undefined;
  }
  const propName = inFilePath[inFilePath.length - 1];
  const parent = getAt(doc, inFilePath.slice(0, -2));
  const list = parent && typeof parent === "object" ? parent["x-properties-added-in-version"] : undefined;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (entry && typeof entry === "object" && entry.propertyName === propName) {
      return entry.addedInVersion;
    }
  }
  return undefined;
}

let propOk = 0;
let propMissingTarget = 0;
const propErrors = [];
for (const loc of expected.values()) {
  const doc = loadYaml(loc.file);
  if (!doc) {
    propMissingTarget++;
    continue;
  }
  const node = getAt(doc, loc.inFilePath);
  if (node == null) {
    propMissingTarget++;
    continue;
  }
  const actual = lookupParentLevelAnnotation(doc, loc.inFilePath);
  if (loc.expectAnnotated) {
    if (actual === undefined) {
      propErrors.push({
        issue: "MISSING_X_PROPERTIES_ADDED_IN_VERSION",
        file: loc.file,
        path: loc.inFilePath.join("/"),
        expected: loc.intro,
      });
    } else if (String(actual) !== String(loc.intro)) {
      propErrors.push({
        issue: "VERSION_MISMATCH",
        file: loc.file,
        path: loc.inFilePath.join("/"),
        expected: loc.intro,
        actual: String(actual),
      });
    } else {
      propOk++;
    }
  } else {
    // Suppressed: an annotation is allowed only if it agrees with the intro.
    if (actual !== undefined && String(actual) !== String(loc.intro)) {
      propErrors.push({
        issue: "UNEXPECTED_ANNOTATION_ON_SUPPRESSED",
        file: loc.file,
        path: loc.inFilePath.join("/"),
        suppressedBy: loc.reason,
        intro: loc.intro,
        actual: String(actual),
      });
    } else {
      propOk++;
    }
  }
}

console.log("\n=== Property Verification ===\n");
const byReason = { rule1: 0, rule3: 0, rule2: 0 };
let expectedAnnotatedCount = 0;
for (const l of expected.values()) {
  if (l.expectAnnotated) expectedAnnotatedCount++;
  else byReason[l.reason] = (byReason[l.reason] ?? 0) + 1;
}
console.log("Property locations checked: " + expected.size);
console.log("  Expected annotated: " + expectedAnnotatedCount);
console.log("  Expected suppressed (Rule 1 — single consumer matches endpoint): " + byReason.rule1);
console.log("  Expected suppressed (Rule 3 — every shared consumer matches endpoint): " + byReason.rule3);
console.log("  Expected suppressed (Rule 2 — every parent location shares the intro): " + byReason.rule2);
console.log("  OK: " + propOk);
console.log("  Target node missing in YAML: " + propMissingTarget);
console.log("  Errors: " + propErrors.length);
if (propErrors.length) {
  console.log("\n--- PROPERTY ERRORS ---");
  for (const e of propErrors) {
    const extras = [
      e.expected ? "expected=" + e.expected : null,
      e.actual ? "actual=" + e.actual : null,
      e.suppressedBy ? "suppressedBy=" + e.suppressedBy : null,
      e.intro && !e.expected ? "intro=" + e.intro : null,
    ].filter(Boolean).join(" ");
    console.log("  " + e.issue + ": " + e.file + " :: " + e.path + (extras ? " " + extras : ""));
  }
}

if (errors.length || extraOps.length || propErrors.length) {
  const total = errors.length + extraOps.length + propErrors.length;
  const affectedFiles = new Set();
  for (const e of errors) if (e.file) affectedFiles.add(e.file);
  for (const e of extraOps) if (e.file) affectedFiles.add(e.file);
  for (const e of propErrors) if (e.file) affectedFiles.add(e.file);
  console.log("");
  console.log(
    `Found ${total} ${total === 1 ? "error" : "errors"} across ${affectedFiles.size} ${affectedFiles.size === 1 ? "file" : "files"}`
  );
  process.exitCode = 1;
}
