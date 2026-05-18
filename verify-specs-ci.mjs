#!/usr/bin/env node
/**
 * PR-oriented CI variant of verify-specs.mjs.
 *
 * Performs the same checks (operation-level `x-added-in-version` and
 * property-level `x-properties-added-in-version` annotations against the
 * version-map) but is tuned for use as a non-blocking PR check:
 *
 *   - Each error is emitted as a single GitHub Actions `::warning::`
 *     workflow command, anchored to the relevant file and line number,
 *     so it surfaces inline in the PR "Files changed" view.
 *   - The script always exits 0. The workflow that calls it is expected
 *     to NOT be a required status check, so warnings never block merge.
 *
 * Required env:
 *   OCA_SPEC_PATH        absolute path to the spec dir (multi-file YAMLs)
 *   VERSION_MAP_PATH     path to version-map.json
 *   ENDPOINT_MAP_PATH    path to endpoint-map.json
 *
 * Optional env:
 *   ANNOTATION_PATH_PREFIX  prefix prepended to each YAML filename when
 *                           emitting `::warning file=...`. Defaults to
 *                           "zeebe/gateway-protocol/src/main/proto/v2"
 *                           (the canonical location inside camunda/camunda).
 *                           Set to empty string to emit bare filenames.
 *   GITHUB_STEP_SUMMARY     when set, a short Markdown summary is appended.
 */

import "dotenv/config";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LineCounter, parseDocument } from "yaml";

const specDir = process.env.OCA_SPEC_PATH;
const versionMapPath = process.env.VERSION_MAP_PATH;
const endpointMapPath = process.env.ENDPOINT_MAP_PATH;
const annotationPrefix =
  process.env.ANNOTATION_PATH_PREFIX ??
  "zeebe/gateway-protocol/src/main/proto/v2";

if (!specDir || !versionMapPath || !endpointMapPath) {
  console.error(
    "Missing required env variables. Set OCA_SPEC_PATH, VERSION_MAP_PATH, and ENDPOINT_MAP_PATH."
  );
  process.exit(1);
}

const versionMap = JSON.parse(readFileSync(versionMapPath, "utf-8"));
const endpointMap = JSON.parse(readFileSync(endpointMapPath, "utf-8"));

const endpointToFile = new Map(Object.entries(endpointMap));
const deletedOps = new Set(Object.keys(versionMap.deletedOperations || {}));

// ── YAML loading with line-number tracking ───────────────────────────────────

const yamlCache = new Map(); // file -> { doc, lineCounter } | null
function loadYaml(file) {
  if (!yamlCache.has(file)) {
    try {
      const src = readFileSync(join(specDir, file), "utf-8");
      const lineCounter = new LineCounter();
      const doc = parseDocument(src, { lineCounter });
      yamlCache.set(file, { doc, lineCounter });
    } catch {
      yamlCache.set(file, null);
    }
  }
  return yamlCache.get(file);
}

function jsValue(entry) {
  if (entry == null) return entry;
  return entry.doc ? entry.doc.toJS({ maxAliasCount: -1 }) : null;
}

function lineOfPath(entry, path) {
  if (!entry) return 1;
  const { doc, lineCounter } = entry;
  const node = doc.getIn(path, true);
  if (node && typeof node === "object" && Array.isArray(node.range)) {
    const offset = node.range[0];
    if (typeof offset === "number") {
      const pos = lineCounter.linePos(offset);
      if (pos && pos.line) return pos.line;
    }
  }
  // Walk back up the path until we find a node with a range.
  for (let i = path.length - 1; i >= 0; i--) {
    const prefix = path.slice(0, i);
    const parent = doc.getIn(prefix, true);
    if (parent && typeof parent === "object" && Array.isArray(parent.range)) {
      const offset = parent.range[0];
      if (typeof offset === "number") {
        const pos = lineCounter.linePos(offset);
        if (pos && pos.line) return pos.line;
      }
    }
  }
  return 1;
}

function getAt(obj, path) {
  let node = obj;
  for (const seg of path) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[seg];
  }
  return node;
}

// ── Operation verification ───────────────────────────────────────────────────

let opOk = 0;
let opSkippedDeleted = 0;
const opErrors = [];

for (const [opKey, info] of Object.entries(versionMap.operations)) {
  if (deletedOps.has(opKey)) {
    opSkippedDeleted++;
    continue;
  }

  const expectedVersion = info.version;
  const sourceFile = endpointToFile.get(opKey);

  if (!sourceFile) {
    opErrors.push({ op: opKey, issue: "NO_ENDPOINT_MAP_ENTRY" });
    continue;
  }

  const spaceIdx = opKey.indexOf(" ");
  const method = opKey.slice(0, spaceIdx).toLowerCase();
  const apiPath = opKey.slice(spaceIdx + 1);

  const entry = loadYaml(sourceFile);
  const doc = jsValue(entry);
  if (!doc) {
    opErrors.push({ op: opKey, issue: "YAML_FILE_NOT_FOUND", file: sourceFile });
    continue;
  }
  if (!doc.paths || !doc.paths[apiPath]) {
    opErrors.push({
      op: opKey,
      issue: "PATH_NOT_IN_YAML",
      file: sourceFile,
      path: apiPath,
      line: 1,
    });
    continue;
  }
  if (!doc.paths[apiPath][method]) {
    opErrors.push({
      op: opKey,
      issue: "METHOD_NOT_IN_YAML",
      file: sourceFile,
      path: apiPath,
      method,
      line: lineOfPath(entry, ["paths", apiPath]),
    });
    continue;
  }

  const operation = doc.paths[apiPath][method];
  const actual = operation["x-added-in-version"];
  const opLine = lineOfPath(entry, ["paths", apiPath, method]);
  if (!actual) {
    opErrors.push({
      op: opKey,
      issue: "MISSING_X_ADDED_IN_VERSION",
      file: sourceFile,
      expected: expectedVersion,
      line: opLine,
    });
  } else if (String(actual) !== String(expectedVersion)) {
    opErrors.push({
      op: opKey,
      issue: "VERSION_MISMATCH",
      file: sourceFile,
      expected: expectedVersion,
      actual: String(actual),
      line: lineOfPath(entry, [
        "paths",
        apiPath,
        method,
        "x-added-in-version",
      ]),
    });
  } else {
    opOk++;
  }
}

// Operations in YAML files that are NOT in version-map.
const versionMapOps = new Set(Object.keys(versionMap.operations));
const allYamlFiles = [...new Set(Object.values(endpointMap))];
const extraOps = [];

for (const file of allYamlFiles) {
  const entry = loadYaml(file);
  const doc = jsValue(entry);
  if (!doc || !doc.paths) continue;
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (!methods[method]) continue;
      const opKey = method.toUpperCase() + " " + path;
      if (!versionMapOps.has(opKey)) {
        const has = methods[method]["x-added-in-version"];
        extraOps.push({
          op: opKey,
          file,
          hasAnnotation: !!has,
          annotationValue: has || null,
          line: lineOfPath(entry, ["paths", path, method]),
        });
      }
    }
  }
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

const expected = new Map();
for (const [key, loc] of locations) {
  const allEndpointsMatchIntro =
    loc.endpointVersions.size > 0
    && [...loc.endpointVersions].every((v) => v === loc.intro);
  if (allEndpointsMatchIntro) {
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

function lookupParentLevelAnnotation(doc, inFilePath) {
  if (inFilePath.length < 2 || inFilePath[inFilePath.length - 2] !== "properties") {
    return undefined;
  }
  const propName = inFilePath[inFilePath.length - 1];
  const parent = getAt(doc, inFilePath.slice(0, -2));
  const list = parent && typeof parent === "object" ? parent["x-properties-added-in-version"] : undefined;
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (item && typeof item === "object" && item.propertyName === propName) {
      return item.addedInVersion;
    }
  }
  return undefined;
}

const allSpecYamlFiles = readdirSync(specDir).filter((f) => f.endsWith(".yaml"));
for (const f of allSpecYamlFiles) loadYaml(f);

const yamlPropAnnotations = [];
function walkForPropertyAnnotations(node, path, file) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkForPropertyAnnotations(node[i], [...path, String(i)], file);
    }
    return;
  }
  const list = node["x-properties-added-in-version"];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item && typeof item === "object" && typeof item.propertyName === "string") {
        yamlPropAnnotations.push({
          file,
          parentPath: path,
          propName: item.propertyName,
          addedInVersion: item.addedInVersion,
        });
      }
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "x-properties-added-in-version") continue;
    walkForPropertyAnnotations(node[key], [...path, key], file);
  }
}
for (const f of allSpecYamlFiles) {
  const doc = jsValue(loadYaml(f));
  if (doc) walkForPropertyAnnotations(doc, [], f);
}

let propOk = 0;
let propMissingTarget = 0;
const propErrors = [];
for (const loc of expected.values()) {
  const entry = loadYaml(loc.file);
  const doc = jsValue(entry);
  if (!doc) { propMissingTarget++; continue; }
  const node = getAt(doc, loc.inFilePath);
  if (node == null) { propMissingTarget++; continue; }
  const actual = lookupParentLevelAnnotation(doc, loc.inFilePath);
  const inFilePath = loc.inFilePath;
  const isPropertyChild =
    inFilePath.length >= 2 && inFilePath[inFilePath.length - 2] === "properties";
  const propName = isPropertyChild ? inFilePath[inFilePath.length - 1] : null;
  const parentPath = isPropertyChild ? inFilePath.slice(0, -2) : inFilePath;
  let parentHasList = false;
  if (isPropertyChild) {
    const parent = getAt(doc, parentPath);
    parentHasList =
      parent && typeof parent === "object" && Array.isArray(parent["x-properties-added-in-version"]);
  }

  if (loc.expectAnnotated) {
    if (actual === undefined) {
      propErrors.push({
        issue: "MISSING_X_PROPERTIES_ADDED_IN_VERSION",
        file: loc.file,
        path: inFilePath.join("/"),
        parentPath: parentPath.join("/"),
        propName,
        parentHasList,
        expected: loc.intro,
        line: lineOfPath(entry, inFilePath),
      });
    } else if (String(actual) !== String(loc.intro)) {
      propErrors.push({
        issue: "VERSION_MISMATCH",
        file: loc.file,
        path: inFilePath.join("/"),
        parentPath: parentPath.join("/"),
        propName,
        expected: loc.intro,
        actual: String(actual),
        line: lineOfPath(entry, [...parentPath, "x-properties-added-in-version"]),
      });
    } else {
      propOk++;
    }
  } else {
    if (actual !== undefined && String(actual) !== String(loc.intro)) {
      propErrors.push({
        issue: "UNEXPECTED_ANNOTATION_ON_SUPPRESSED",
        file: loc.file,
        path: inFilePath.join("/"),
        parentPath: parentPath.join("/"),
        propName,
        suppressedBy: loc.reason,
        intro: loc.intro,
        actual: String(actual),
        line: lineOfPath(entry, [...parentPath, "x-properties-added-in-version"]),
      });
    } else {
      propOk++;
    }
  }
}

for (const ann of yamlPropAnnotations) {
  const inFilePath = [...ann.parentPath, "properties", ann.propName];
  const key = locationKey(ann.file, inFilePath);
  if (expected.has(key)) continue;
  const entry = loadYaml(ann.file);
  const doc = jsValue(entry);
  const parent = doc ? getAt(doc, ann.parentPath) : null;
  const propsMap =
    parent && typeof parent === "object" && parent.properties && typeof parent.properties === "object"
      ? parent.properties
      : null;
  const hasProp = !!(propsMap && Object.prototype.hasOwnProperty.call(propsMap, ann.propName));
  propErrors.push({
    issue: hasProp ? "UNKNOWN_PROPERTY_ANNOTATION" : "ORPHAN_PROPERTY_ANNOTATION",
    file: ann.file,
    path: inFilePath.join("/"),
    parentPath: ann.parentPath.join("/"),
    propName: ann.propName,
    actual: ann.addedInVersion != null ? String(ann.addedInVersion) : null,
    line: lineOfPath(entry, [...ann.parentPath, "x-properties-added-in-version"]),
  });
}

for (const f of allSpecYamlFiles) {
  const entry = loadYaml(f);
  const doc = jsValue(entry);
  if (!doc || !doc.paths) continue;
  for (const [apiPath, methods] of Object.entries(doc.paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = methods[method];
      if (!op || typeof op !== "object") continue;
      const opKey = method.toUpperCase() + " " + apiPath;
      if (deletedOps.has(opKey) && op["x-added-in-version"] !== undefined) {
        opErrors.push({
          op: opKey,
          issue: "UNEXPECTED_ANNOTATION_ON_DELETED_OPERATION",
          file: f,
          actual: String(op["x-added-in-version"]),
          line: lineOfPath(entry, [
            "paths",
            apiPath,
            method,
            "x-added-in-version",
          ]),
        });
      }
    }
  }
}

// ── Output: GitHub Actions warning annotations ──────────────────────────────

function annotationPath(file) {
  if (!file) return "";
  return annotationPrefix ? `${annotationPrefix}/${file}` : file;
}

// Escape per GitHub Actions workflow command rules.
function escapeProp(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function escapeMsg(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function emitWarning({ file, line, title, message }) {
  const parts = [];
  if (file) parts.push(`file=${escapeProp(annotationPath(file))}`);
  if (typeof line === "number" && line > 0) parts.push(`line=${line}`);
  if (title) parts.push(`title=${escapeProp(title)}`);
  const head = parts.length ? `::warning ${parts.join(",")}::` : "::warning::";
  console.log(head + escapeMsg(message));
}

function messageForOperation(e) {
  switch (e.issue) {
    case "MISSING_X_ADDED_IN_VERSION":
      return `Operation \`${e.op}\` is missing \`x-added-in-version\`. Expected: ${e.expected}.`;
    case "VERSION_MISMATCH":
      return `Operation \`${e.op}\` has \`x-added-in-version: ${e.actual}\` but version-map says ${e.expected}.`;
    case "NO_ENDPOINT_MAP_ENTRY":
      return `Operation \`${e.op}\` is in version-map but missing from endpoint-map.json. Regenerate the endpoint map.`;
    case "YAML_FILE_NOT_FOUND":
      return `Operation \`${e.op}\` references YAML file \`${e.file}\` which does not exist in the spec dir.`;
    case "PATH_NOT_IN_YAML":
      return `Path \`${e.path}\` is missing from \`${e.file}\` (required for operation \`${e.op}\`).`;
    case "METHOD_NOT_IN_YAML":
      return `Method \`${e.method?.toUpperCase()}\` is missing for path \`${e.path}\` in \`${e.file}\` (required for operation \`${e.op}\`).`;
    case "UNEXPECTED_ANNOTATION_ON_DELETED_OPERATION":
      return `Operation \`${e.op}\` is marked deleted in the version-map but still carries \`x-added-in-version: ${e.actual}\`. Remove the annotation (and likely the operation).`;
    default:
      return `${e.issue}: ${e.op}`;
  }
}

function messageForProperty(e) {
  switch (e.issue) {
    case "MISSING_X_PROPERTIES_ADDED_IN_VERSION":
      return `Property \`${e.propName ?? e.path}\` on \`${e.parentPath ?? "(root)"}\` is missing an \`x-properties-added-in-version\` entry. Expected version: ${e.expected}.`;
    case "VERSION_MISMATCH":
      return `Property \`${e.propName ?? e.path}\` on \`${e.parentPath}\` has \`addedInVersion: ${e.actual}\` but expected ${e.expected}.`;
    case "UNEXPECTED_ANNOTATION_ON_SUPPRESSED":
      return `Property \`${e.propName ?? e.path}\` on \`${e.parentPath}\` carries \`addedInVersion: ${e.actual}\` but should be suppressed by ${e.suppressedBy} (aggregated intro: ${e.intro}). Remove the entry.`;
    case "ORPHAN_PROPERTY_ANNOTATION":
      return `\`x-properties-added-in-version\` on \`${e.parentPath}\` lists \`${e.propName}\`, but no such property exists on this schema. Remove the entry.`;
    case "UNKNOWN_PROPERTY_ANNOTATION":
      return `\`x-properties-added-in-version\` on \`${e.parentPath}\` lists \`${e.propName}\` (addedInVersion: ${e.actual}), but the version-map does not track this location. Either remove the entry or regenerate version-map.json.`;
    default:
      return `${e.issue}: ${e.path}`;
  }
}

for (const e of opErrors) {
  emitWarning({
    file: e.file,
    line: e.line,
    title: `OpenAPI: ${e.issue}`,
    message: messageForOperation(e),
  });
}
for (const e of extraOps) {
  emitWarning({
    file: e.file,
    line: e.line,
    title: "OpenAPI: UNKNOWN_OPERATION_IN_YAML",
    message: `Operation \`${e.op}\` exists in \`${e.file}\` but is not in version-map.json. Add it to the version-map or remove it from the YAML.`,
  });
}
for (const e of propErrors) {
  emitWarning({
    file: e.file,
    line: e.line,
    title: `OpenAPI: ${e.issue}`,
    message: messageForProperty(e),
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────

const totalErrors = opErrors.length + extraOps.length + propErrors.length;
const affectedFiles = new Set();
for (const e of opErrors) if (e.file) affectedFiles.add(e.file);
for (const e of extraOps) if (e.file) affectedFiles.add(e.file);
for (const e of propErrors) if (e.file) affectedFiles.add(e.file);

if (totalErrors === 0) {
  console.log("OpenAPI annotation verification: no errors.");
} else {
  console.log(
    `OpenAPI annotation verification: ${totalErrors} ${totalErrors === 1 ? "warning" : "warnings"} across ${affectedFiles.size} ${affectedFiles.size === 1 ? "file" : "files"} (non-blocking).`
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [];
  lines.push("# OpenAPI annotation verification (non-blocking)");
  lines.push("");
  if (totalErrors === 0) {
    lines.push("**Status:** ✅ No errors.");
  } else {
    lines.push(
      `**Status:** ⚠️ ${totalErrors} ${totalErrors === 1 ? "warning" : "warnings"} across ${affectedFiles.size} ${affectedFiles.size === 1 ? "file" : "files"}.`
    );
    lines.push("");
    lines.push("See the **Files changed** tab for inline annotations.");
    lines.push("");
    if (opErrors.length || extraOps.length) {
      lines.push("## Operation warnings");
      lines.push("");
      for (const e of opErrors) {
        lines.push(`- \`${e.issue}\` — \`${e.op}\`${e.file ? ` (\`${e.file}\`${e.line ? `:${e.line}` : ""})` : ""}`);
      }
      for (const e of extraOps) {
        lines.push(`- \`UNKNOWN_OPERATION_IN_YAML\` — \`${e.op}\` (\`${e.file}\`${e.line ? `:${e.line}` : ""})`);
      }
      lines.push("");
    }
    if (propErrors.length) {
      lines.push("## Property warnings");
      lines.push("");
      for (const e of propErrors) {
        lines.push(`- \`${e.issue}\` — \`${e.path}\` (\`${e.file}\`${e.line ? `:${e.line}` : ""})`);
      }
      lines.push("");
    }
  }
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  } catch (err) {
    console.error(`Failed to append job summary: ${err.message}`);
  }
}

// Always exit 0 — this script is meant to be a non-blocking PR check.
process.exit(0);
